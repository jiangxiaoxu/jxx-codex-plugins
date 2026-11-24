using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using SQLitePCL;
using static SQLitePCL.raw;

namespace ThreadMemoryHook;

internal sealed class HookStore(string home)
{
    private const int SchemaVersion = 1;
    private const int DefaultBusyTimeoutMilliseconds = 1000;
    private const int MaxDiagnostics = 2048;
    private const int DetailsLimit = 512;
    private const long BucketWidth = 5000;
    private const long NoTokenBucket = long.MinValue;
    private static readonly string[] PhaseMetrics = ["first", "followup_1", "followup_2", "receipt_confirmed"];
    private readonly string database = Path.Combine(home, "state", "plugins", "thread-memory", "handoff.sqlite3");

    internal SqliteConnection? OpenRead() => OpenExisting(SqliteOpenMode.ReadOnly);

    internal SqliteConnection OpenWrite(int busyTimeoutMilliseconds = DefaultBusyTimeoutMilliseconds)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(database)!);
        SqliteConnection connection = Open(SqliteOpenMode.ReadWriteCreate, busyTimeoutMilliseconds);
        try
        {
            if (ReadVersion(connection) == 0)
            {
                InWriteTransaction(connection, () =>
                {
                    if (ReadVersion(connection) == 0)
                        RunScript(connection, SchemaV1);
                });
            }
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    internal string? LoadCheckpoint(string thread, string path)
    {
        using SqliteConnection? connection = OpenRead();
        if (connection is null)
            return null;
        using sqlite3_stmt statement = Prepare(connection, """
            SELECT checkpoint FROM rollout_scan_checkpoints WHERE thread_id = ? AND rollout_path = ?
            """, thread, path);
        return ReadRow(connection, statement) ? sqlite3_column_text(statement, 0).utf8_to_string() : null;
    }

    internal IReadOnlyList<StoredCheckpoint> LoadCheckpointAliases(string thread, string canonicalKey)
    {
        using SqliteConnection? connection = OpenRead();
        if (connection is null)
            return [];
        using sqlite3_stmt statement = Prepare(connection, """
            SELECT rollout_path, checkpoint FROM rollout_scan_checkpoints
            WHERE thread_id = ? AND rollout_path <> ? ORDER BY rollout_path
            """, thread, canonicalKey);
        List<StoredCheckpoint> aliases = [];
        while (ReadRow(connection, statement))
        {
            aliases.Add(new(sqlite3_column_text(statement, 0).utf8_to_string(),
                sqlite3_column_text(statement, 1).utf8_to_string()));
        }
        return aliases;
    }

    internal void SaveCheckpoint(string thread, string path, string? previous, string next,
        IReadOnlyList<StoredCheckpoint>? verifiedAliases = null)
    {
        if (previous == next && verifiedAliases is not { Count: > 0 })
            return;
        using SqliteConnection? connection = previous is null ? OpenWrite() : OpenExisting(SqliteOpenMode.ReadWrite);
        if (connection is null)
            return;

        if (verifiedAliases is not { Count: > 0 })
        {
            WriteCheckpoint(connection, thread, path, previous, next);
            return;
        }

        InWriteTransaction(connection, () =>
        {
            bool canonicalMatches = previous == next
                ? Exists(connection, """
                    SELECT 1 FROM rollout_scan_checkpoints
                    WHERE thread_id = ? AND rollout_path = ? AND checkpoint = ?
                    """, thread, path, next)
                : WriteCheckpoint(connection, thread, path, previous, next);
            if (!canonicalMatches)
                return;

            foreach (StoredCheckpoint alias in verifiedAliases)
            {
                if (alias.Path == path)
                    continue;
                Execute(connection, """
                    DELETE FROM rollout_scan_checkpoints
                    WHERE thread_id = ? AND rollout_path = ? AND checkpoint = ?
                    """, thread, alias.Path, alias.Raw);
            }
        });
    }

    private static bool WriteCheckpoint(SqliteConnection connection, string thread, string path,
        string? previous, string next)
    {
        if (previous is null)
        {
            return Execute(connection, """
                INSERT INTO rollout_scan_checkpoints (thread_id, rollout_path, checkpoint) VALUES (?, ?, ?)
                ON CONFLICT (thread_id, rollout_path) DO NOTHING
                """, thread, path, next) == 1;
        }
        return Execute(connection, """
            UPDATE rollout_scan_checkpoints SET checkpoint = ?
            WHERE thread_id = ? AND rollout_path = ? AND checkpoint = ?
            """, next, thread, path, previous) == 1;
    }

    internal HashSet<int> Claim(string thread, string window, IReadOnlyList<(int Tier, int Stage)> phases,
        IReadOnlyList<string>? equivalentWindows = null)
    {
        HashSet<int> advanced = [];
        if (phases.Count == 0)
            return advanced;

        Dictionary<int, int> stages = [];
        foreach ((int tier, int stage) in phases)
            stages[tier] = stages.TryGetValue(tier, out int previous) ? Math.Max(previous, stage) : stage;

        using SqliteConnection connection = OpenWrite();
        InWriteTransaction(connection, () =>
        {
            if (equivalentWindows is not null)
            {
                foreach (string equivalent in equivalentWindows)
                {
                    if (equivalent == window)
                        continue;
                    Execute(connection, """
                        INSERT INTO reminder_claims (thread_id, window, level, stage)
                        SELECT thread_id, ?, level, stage FROM reminder_claims WHERE thread_id = ? AND window = ?
                        ON CONFLICT (thread_id, window, level) DO UPDATE SET stage = excluded.stage
                        WHERE excluded.stage > reminder_claims.stage
                        """, window, thread, equivalent);
                }
            }
            foreach ((int tier, int stage) in stages)
            {
                if (Execute(connection, """
                    INSERT INTO reminder_claims (thread_id, window, level, stage) VALUES (?, ?, ?, ?)
                    ON CONFLICT (thread_id, window, level) DO UPDATE SET stage = excluded.stage
                    WHERE excluded.stage > reminder_claims.stage
                    """, thread, window, tier, stage) == 1)
                {
                    advanced.Add(tier);
                }
            }
        });
        return advanced;
    }

    internal void MarkCompaction(string thread)
    {
        using SqliteConnection connection = OpenWrite();
        Execute(connection, "INSERT OR IGNORE INTO child_compactions (thread_id) VALUES (?)", thread);
    }

    internal bool TakeCompaction(string thread)
    {
        using (SqliteConnection? readConnection = OpenRead())
        {
            if (readConnection is null || !Exists(readConnection,
                "SELECT 1 FROM child_compactions WHERE thread_id = ?", thread))
                return false;
        }
        using SqliteConnection? connection = OpenExisting(SqliteOpenMode.ReadWrite);
        return connection is not null &&
            Execute(connection, "DELETE FROM child_compactions WHERE thread_id = ?", thread) == 1;
    }

    internal void Diagnostic(string thread, string eventName, string? window = null, JsonObject? details = null)
    {
        try
        {
            using SqliteConnection connection = OpenWrite(0);
            InWriteTransaction(connection, () =>
            {
                InsertDiagnostic(connection, thread, eventName, window, details);
                TrimDiagnostics(connection);
            });
        }
        catch (Exception error) when (IsOptionalWriteError(error))
        {
            // Diagnostics never wait for the writer or affect Hook decisions.
        }
    }

    internal bool Telemetry(
        string thread,
        string? window = null,
        string? notifyId = null,
        (long First, long Check, long Final) leads = default,
        long? used = null,
        IReadOnlyList<(int Tier, int Stage, long Startup)>? decisions = null,
        IReadOnlyList<ReminderReceipt>? receipts = null,
        IReadOnlyList<CompactionObservation>? compactions = null)
    {
        if ((decisions?.Count ?? 0) == 0 && (receipts?.Count ?? 0) == 0 && (compactions?.Count ?? 0) == 0)
            return true;
        try
        {
            using SqliteConnection connection = OpenWrite(0);
            InWriteTransaction(connection, () =>
            {
                if (!Exists(connection, """
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminder_telemetry_totals'
                    """))
                    RunScript(connection, TelemetrySchema);

                if (decisions is { Count: > 0 })
                {
                    string encodedLeads = FormattableString.Invariant($"[{leads.First},{leads.Check},{leads.Final}]");
                    foreach ((int tier, int stage, long startup) in decisions)
                    {
                        if (window is not null && notifyId is not null && stage != 3)
                        {
                            Execute(connection, """
                                INSERT INTO reminder_delivery_policies (thread_id, notify_id, tier, window, leads)
                                VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
                                """, thread, notifyId, tier, window, encodedLeads);
                        }
                        long bucket = used is null ? NoTokenBucket : RoundBucket(checked(startup - used.Value));
                        IncrementTotal(connection, encodedLeads, tier, PhaseMetrics[stage], bucket);
                    }
                }

                bool observed = false;
                foreach (ReminderReceipt receipt in receipts ?? [])
                    observed |= RecordDelivery(connection, thread, receipt);
                foreach (CompactionObservation compaction in compactions ?? [])
                    observed |= RecordCompaction(connection, thread, compaction);
                if (observed)
                    TrimDiagnostics(connection);
            });
            return true;
        }
        catch (Exception error) when (IsOptionalWriteError(error))
        {
            // A failed observation batch leaves the scan checkpoint available for another callback.
            return false;
        }
    }

    private static bool RecordDelivery(SqliteConnection connection, string thread, ReminderReceipt receipt)
    {
        string notify = receipt.NotifyId;
        int tier = receipt.Tier;
        if (Execute(connection, """
            INSERT INTO reminder_deliveries (thread_id, notify_id, tier, record_key)
            VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
            """, thread, notify, tier, receipt.RecordKey) == 0)
            return false;

        bool duplicate = Exists(connection, """
            SELECT 1 FROM reminder_deliveries
            WHERE thread_id = ? AND notify_id = ? AND tier = ? LIMIT 1 OFFSET 1
            """, thread, notify, tier);
        string? window = null;
        string? encodedLeads = null;
        using (sqlite3_stmt statement = Prepare(connection, """
            SELECT window, leads FROM reminder_delivery_policies
            WHERE thread_id = ? AND notify_id = ? AND tier = ?
            """, thread, notify, tier))
        {
            if (ReadRow(connection, statement))
            {
                window = sqlite3_column_text(statement, 0).utf8_to_string();
                encodedLeads = sqlite3_column_text(statement, 1).utf8_to_string();
            }
        }

        JsonObject details = new()
        {
            ["notify_id"] = notify,
            ["tier"] = tier,
            ["recorded_at"] = receipt.RecordedAt,
            ["duplicate"] = duplicate,
        };
        if (encodedLeads is not null)
        {
            IncrementTotal(connection, encodedLeads, tier, "delivery_observed", NoTokenBucket);
            if (duplicate)
                IncrementTotal(connection, encodedLeads, tier, "duplicate_observed", NoTokenBucket);
            details["leads"] = JsonNode.Parse(encodedLeads);
        }
        InsertDiagnostic(connection, thread, "reminder_rollout_observed", window, details);
        return true;
    }

    private static bool RecordCompaction(SqliteConnection connection, string thread, CompactionObservation compaction)
    {
        if (Execute(connection, """
            INSERT INTO reminder_compactions (thread_id, window) VALUES (?, ?) ON CONFLICT DO NOTHING
            """, thread, compaction.Window) == 0)
            return false;

        string? compactedAt = compaction.CompactedAt;
        string? updatedAt = null;
        long? cutoff = null;
        if (compactedAt is not null)
        {
            try
            {
                cutoff = ThreadMemory.TimestampUs(compactedAt);
            }
            catch (InvalidDataException)
            {
                compactedAt = null;
            }
        }
        if (cutoff is long effectiveUs)
        {
            using sqlite3_stmt statement = Prepare(connection, """
                SELECT CASE WHEN summary <> '' THEN updated_us END FROM memory_revisions
                WHERE thread_id = ? AND effective_us <= ?
                ORDER BY effective_us DESC, revision DESC LIMIT 1
                """, thread, effectiveUs);
            if (ReadRow(connection, statement) && sqlite3_column_type(statement, 0) != SQLITE_NULL)
                updatedAt = FormatTimestamp(sqlite3_column_int64(statement, 0));
        }

        InsertDiagnostic(connection, thread, "compaction_checkpoint_observed", compaction.Window, new JsonObject
        {
            ["compacted_at"] = compactedAt,
            ["previous_window"] = compaction.PreviousWindow,
            ["note_updated_at"] = updatedAt,
        });
        return true;
    }

    private static void IncrementTotal(SqliteConnection connection, string leads, int tier, string metric, long bucket)
    {
        Execute(connection, """
            INSERT INTO reminder_telemetry_totals (leads, tier, metric, bucket, count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT (leads, tier, metric, bucket) DO UPDATE SET count = count + 1
            """, leads, tier, metric, bucket);
    }

    private static long RoundBucket(long value)
    {
        long remainder = value % BucketWidth;
        return checked(value - (remainder < 0 ? BucketWidth + remainder : remainder));
    }

    private static void InsertDiagnostic(
        SqliteConnection connection, string thread, string eventName, string? window, JsonObject? details)
    {
        string? encoded = details is { Count: > 0 } ? details.ToJsonString() : null;
        Execute(connection, """
            INSERT INTO hook_diagnostics (thread_id, timestamp_us, event, window, details)
            VALUES (?, ?, ?, ?, ?)
            """, thread, NowMicroseconds(), eventName, window, encoded is { Length: <= DetailsLimit } ? encoded : null);
    }

    private static void TrimDiagnostics(SqliteConnection connection)
    {
        Execute(connection, """
            DELETE FROM hook_diagnostics WHERE id <= (
                SELECT id FROM hook_diagnostics ORDER BY id DESC LIMIT 1 OFFSET ?
            )
            """, MaxDiagnostics);
    }

    internal static long NowMicroseconds() => Microseconds(DateTime.UtcNow.Ticks);

    private static long Microseconds(long utcTicks)
    {
        long ticks = utcTicks - DateTime.UnixEpoch.Ticks;
        return ticks / 10 - (ticks % 10 < 0 ? 1 : 0);
    }

    internal static string FormatTimestamp(long microseconds) =>
        DateTime.UnixEpoch.AddTicks(checked(microseconds * 10))
            .ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    private static bool IsOptionalWriteError(Exception error) =>
        error is SqliteException or IOException or UnauthorizedAccessException or
            ArgumentException or InvalidOperationException or System.Text.Json.JsonException or OverflowException;

    internal SqliteConnection? OpenExisting(SqliteOpenMode mode)
    {
        try
        {
            File.GetAttributes(database);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        SqliteConnection connection = Open(mode, DefaultBusyTimeoutMilliseconds);
        try
        {
            if (ReadVersion(connection) == SchemaVersion)
                return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
        connection.Dispose();
        return null;
    }

    private SqliteConnection Open(SqliteOpenMode mode, int busyTimeoutMilliseconds)
    {
        SqliteConnection connection = new(new SqliteConnectionStringBuilder
        {
            DataSource = database,
            Mode = mode,
            Pooling = false,
            DefaultTimeout = DefaultBusyTimeoutMilliseconds / 1000,
        }.ToString());
        try
        {
            connection.Open();
            SqliteException.ThrowExceptionForRC(sqlite3_busy_timeout(connection.Handle!, busyTimeoutMilliseconds),
                connection.Handle);
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }

    private static int ReadVersion(SqliteConnection connection)
    {
        using sqlite3_stmt statement = Prepare(connection, "PRAGMA user_version");
        ReadRow(connection, statement);
        int version = sqlite3_column_int(statement, 0);
        if (version is not 0 and not SchemaVersion)
            throw new SqliteException($"Unsupported Thread Memory database schema version {version}. " +
                $"This plugin supports version {SchemaVersion}.", SQLITE_ERROR);
        return version;
    }

    private static void InWriteTransaction(SqliteConnection connection, Action action)
    {
        RunScript(connection, "BEGIN IMMEDIATE");
        try
        {
            action();
            RunScript(connection, "COMMIT");
        }
        catch
        {
            sqlite3_exec(connection.Handle!, "ROLLBACK");
            throw;
        }
    }

    private static void RunScript(SqliteConnection connection, string script) =>
        SqliteException.ThrowExceptionForRC(sqlite3_exec(connection.Handle!, script), connection.Handle);

    // Microsoft.Data.Sqlite retries SQLITE_BUSY independently of SQLite's busy timeout.
    // Direct steps let diagnostics and telemetry give up immediately on lock contention.
    private static sqlite3_stmt Prepare(SqliteConnection connection, string sql, params object?[] parameters)
    {
        int prepared = sqlite3_prepare_v2(connection.Handle!, sql, out sqlite3_stmt statement);
        try
        {
            SqliteException.ThrowExceptionForRC(prepared, connection.Handle);
            for (int index = 0; index < parameters.Length; index++)
            {
                int position = index + 1;
                int bound = parameters[index] switch
                {
                    null => sqlite3_bind_null(statement, position),
                    string text => sqlite3_bind_text(statement, position, text),
                    int integer => sqlite3_bind_int(statement, position, integer),
                    long integer => sqlite3_bind_int64(statement, position, integer),
                    _ => throw new ArgumentException("Unsupported Hook SQLite parameter"),
                };
                SqliteException.ThrowExceptionForRC(bound, connection.Handle);
            }
            return statement;
        }
        catch
        {
            statement?.Dispose();
            throw;
        }
    }

    private static bool ReadRow(SqliteConnection connection, sqlite3_stmt statement)
    {
        int status = sqlite3_step(statement);
        SqliteException.ThrowExceptionForRC(status, connection.Handle);
        return status == SQLITE_ROW;
    }

    private static bool Exists(SqliteConnection connection, string sql, params object?[] parameters)
    {
        using sqlite3_stmt statement = Prepare(connection, sql, parameters);
        return ReadRow(connection, statement);
    }

    private static int Execute(SqliteConnection connection, string sql, params object?[] parameters)
    {
        using sqlite3_stmt statement = Prepare(connection, sql, parameters);
        SqliteException.ThrowExceptionForRC(sqlite3_step(statement), connection.Handle);
        return sqlite3_changes(connection.Handle!);
    }

    // Keep this schema aligned with the Python notes CLI and Desktop MCP store.
    private const string SchemaV1 = """
        CREATE TABLE handoffs (
            thread_id TEXT NOT NULL,
            window TEXT NOT NULL,
            summary TEXT,
            saved_at TEXT,
            PRIMARY KEY (thread_id, window)
        );
        CREATE TABLE handoff_history (
            revision INTEGER PRIMARY KEY,
            thread_id TEXT NOT NULL,
            window TEXT NOT NULL,
            summary TEXT NOT NULL,
            saved_at TEXT NOT NULL
        );
        CREATE INDEX handoff_history_thread ON handoff_history (thread_id);
        CREATE TRIGGER archive_handoff
        BEFORE UPDATE OF summary ON handoffs
        WHEN OLD.summary IS NOT NULL AND OLD.summary <> '' AND OLD.saved_at IS NOT NULL
        BEGIN
            INSERT INTO handoff_history (thread_id, window, summary, saved_at)
            VALUES (OLD.thread_id, OLD.window, OLD.summary, OLD.saved_at);
        END;
        CREATE TABLE memory_revisions (
            revision INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id TEXT NOT NULL,
            summary TEXT,
            updated_us INTEGER NOT NULL,
            effective_us INTEGER NOT NULL
        );
        CREATE INDEX memory_revisions_thread_time ON memory_revisions (thread_id, effective_us, revision);
        CREATE TABLE child_compactions (
            thread_id TEXT PRIMARY KEY NOT NULL
        );
        CREATE TABLE reminder_claims (
            thread_id TEXT NOT NULL,
            window TEXT NOT NULL,
            level INTEGER NOT NULL,
            stage INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 3),
            PRIMARY KEY (thread_id, window, level)
        );
        CREATE TABLE rollout_scan_checkpoints (
            thread_id TEXT NOT NULL,
            rollout_path TEXT NOT NULL,
            checkpoint TEXT NOT NULL,
            PRIMARY KEY (thread_id, rollout_path)
        );
        CREATE TABLE hook_diagnostics (
            id INTEGER PRIMARY KEY,
            thread_id TEXT NOT NULL CHECK (length(thread_id) = 36),
            timestamp_us INTEGER NOT NULL,
            event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
            window TEXT CHECK (length(window) <= 64),
            details TEXT
        );
        CREATE INDEX hook_diagnostics_thread ON hook_diagnostics (thread_id, id);
        PRAGMA user_version = 1;
        """;

    private const string TelemetrySchema = """
        CREATE TABLE IF NOT EXISTS reminder_delivery_policies (
            thread_id TEXT NOT NULL,
            notify_id TEXT NOT NULL,
            tier INTEGER NOT NULL,
            window TEXT NOT NULL,
            leads TEXT NOT NULL,
            PRIMARY KEY (thread_id, notify_id, tier)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS reminder_deliveries (
            thread_id TEXT NOT NULL,
            notify_id TEXT NOT NULL,
            tier INTEGER NOT NULL,
            record_key TEXT NOT NULL,
            PRIMARY KEY (thread_id, notify_id, tier, record_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS reminder_compactions (
            thread_id TEXT NOT NULL,
            window TEXT NOT NULL,
            PRIMARY KEY (thread_id, window)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS reminder_telemetry_totals (
            leads TEXT NOT NULL,
            tier INTEGER NOT NULL,
            metric TEXT NOT NULL,
            bucket INTEGER NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (leads, tier, metric, bucket)
        ) WITHOUT ROWID;
        """;
}
