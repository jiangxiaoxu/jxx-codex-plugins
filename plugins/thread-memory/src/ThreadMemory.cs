using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace ThreadMemoryHook;

internal static class ThreadMemory
{
    private sealed record Note(string? Summary, long UpdatedUs);

    private sealed class InheritanceUnavailable(Exception inner)
        : Exception("Cannot inherit the thread note.", inner);

    private const string LegacyRevisions = """
        WITH versions AS (
            SELECT summary, saved_at, window, 1 AS is_current, 0 AS revision FROM handoffs WHERE thread_id = $id
            UNION ALL
            SELECT summary, saved_at, window, 0, revision FROM handoff_history WHERE thread_id = $id
        ), timed AS (
            SELECT *, CASE LENGTH(saved_at)
                WHEN 20 THEN SUBSTR(saved_at, 1, 19) || '.000000Z'
                WHEN 24 THEN SUBSTR(saved_at, 1, 23) || '000Z'
                ELSE saved_at
            END AS at FROM versions WHERE summary <> '' AND saved_at IS NOT NULL
        )
        SELECT summary, saved_at FROM timed
        """;

    internal static string NoteStatus(HookStore store, string home, string threadId)
    {
        try
        {
            if (!Guid.TryParse(threadId, out Guid uuid))
                return "invalid_data";
            var note = Initialize(store, home, uuid.ToString("D"), []);
            return !string.IsNullOrEmpty(note?.Summary) ? "available" : "missing";
        }
        catch (InheritanceUnavailable)
        {
            return "inheritance_unavailable";
        }
        catch (Exception error) when (error is InvalidDataException or ArgumentException or JsonException or InvalidOperationException)
        {
            return "invalid_data";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return "io_error";
        }
        catch (SqliteException)
        {
            return "sqlite_error";
        }
    }

    private static Note? Initialize(HookStore store, string home, string threadId, HashSet<string> visiting)
    {
        using (var connection = store.OpenRead())
        {
            if (connection is not null && ReadNote(connection, threadId) is { } own)
                return own;
        }

        string? original = SessionFiles.FindRollout(home, threadId);
        string path = original ?? SessionFiles.FindRollout(home, threadId, current: true)
            ?? throw new FileNotFoundException($"No local rollout found for {threadId}.");
        var header = SessionFiles.ReadHeader(path);
        if (SessionFiles.String(header, "id") != threadId)
            throw new InvalidDataException($"Rollout header does not identify thread {threadId}.");

        string? parent = SessionFiles.String(header, "forked_from_id");
        if (parent is null || IsSubagent(header))
        {
            using (var connection = store.OpenRead())
            {
                if (connection is null)
                    return null;
                if (ReadLegacy(connection, threadId) is null)
                    return ReadNote(connection, threadId);
            }
            return InitializeRevisions(store, threadId);
        }

        long forkUs;
        Note? inherited;
        try
        {
            if (original is null)
                throw new InvalidDataException($"Original rollout required for fork creation time of {threadId}.");
            if (!Guid.TryParse(parent, out Guid parentId))
                throw new InvalidDataException($"Invalid fork parent for {threadId}.");
            forkUs = TimestampUs(SessionFiles.String(header, "timestamp"));
            visiting.Add(threadId);
            try
            {
                inherited = NoteAt(store, home, parentId.ToString("D"), forkUs, visiting);
            }
            finally
            {
                visiting.Remove(threadId);
            }
        }
        catch (Exception error) when (error is IOException or InvalidDataException or ArgumentException
            or UnauthorizedAccessException or InvalidOperationException)
        {
            throw new InheritanceUnavailable(error);
        }
        var baseline = inherited is { Summary: not null } ? inherited : new Note(null, forkUs);
        return InitializeRevisions(store, threadId, baseline, forkUs);
    }

    private static Note? NoteAt(HookStore store, string home, string threadId, long cutoffUs, HashSet<string> visiting)
    {
        if (visiting.Contains(threadId))
            throw new InvalidDataException($"Cycle in rollout fork ancestry at {threadId}.");

        using (var connection = store.OpenRead())
        {
            if (connection is not null)
            {
                if (ReadNote(connection, threadId, cutoffUs) is { } note)
                    return note;
                if (ReadLegacy(connection, threadId, cutoffUs) is { } fallback)
                    return fallback;
            }
        }
        Initialize(store, home, threadId, visiting);
        using var initialized = store.OpenRead();
        return initialized is null ? null : ReadNote(initialized, threadId, cutoffUs);
    }

    private static bool IsSubagent(JsonElement header)
    {
        var source = SessionFiles.Property(header, "source");
        if (source.ValueKind == JsonValueKind.Object && source.TryGetProperty("subagent", out _))
            return true;
        if (HasSpawnParent(header)
            || SessionFiles.String(header, "thread_source") == "subagent"
            || SessionFiles.Property(header, "subagent_history_start_ordinal").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
            return true;
        string? value = SessionFiles.String(header, "source");
        return value is not null && (value.Equals("subagent", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("subagent_", StringComparison.OrdinalIgnoreCase));
    }

    private static bool HasSpawnParent(JsonElement header)
    {
        var parent = SessionFiles.Property(header, "parent_thread_id");
        return parent.ValueKind switch
        {
            JsonValueKind.String => !string.IsNullOrEmpty(parent.GetString()),
            JsonValueKind.True => true,
            JsonValueKind.Number => !parent.TryGetDouble(out double number) || number != 0,
            JsonValueKind.Array => parent.GetArrayLength() > 0,
            JsonValueKind.Object => parent.EnumerateObject().Any(),
            _ => false,
        };
    }

    private static Note? InitializeRevisions(HookStore store, string threadId, Note? baseline = null, long? forkUs = null)
    {
        using var connection = store.OpenWrite();
        using var transaction = connection.BeginTransaction(deferred: false);
        if (ReadNote(connection, threadId, transaction: transaction) is { } existing)
        {
            transaction.Commit();
            return existing;
        }

        using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = """
            INSERT INTO memory_revisions (thread_id, summary, updated_us, effective_us)
            VALUES ($id, $summary, $updated, $effective)
            """;
        insert.Parameters.AddWithValue("$id", threadId);
        var summary = insert.Parameters.Add("$summary", SqliteType.Text);
        var updated = insert.Parameters.Add("$updated", SqliteType.Integer);
        var effective = insert.Parameters.Add("$effective", SqliteType.Integer);

        if (baseline is not null && forkUs is long birth)
        {
            summary.Value = (object?)baseline.Summary ?? DBNull.Value;
            updated.Value = baseline.UpdatedUs;
            effective.Value = birth;
            insert.ExecuteNonQuery();
        }

        using (var legacy = connection.CreateCommand())
        {
            legacy.Transaction = transaction;
            legacy.CommandText = LegacyRevisions + "\nORDER BY at, window, is_current, revision";
            legacy.Parameters.AddWithValue("$id", threadId);
            using var versions = legacy.ExecuteReader();
            while (versions.Read())
            {
                long savedUs = TimestampUs(versions.GetString(1));
                summary.Value = versions.GetString(0);
                updated.Value = savedUs;
                effective.Value = Math.Max(savedUs, forkUs ?? savedUs);
                insert.ExecuteNonQuery();
            }
        }

        var current = ReadNote(connection, threadId, transaction: transaction);
        transaction.Commit();
        return current;
    }

    private static Note? ReadNote(SqliteConnection connection, string threadId, long? cutoffUs = null, SqliteTransaction? transaction = null)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT summary, updated_us FROM memory_revisions WHERE thread_id = $id
            """;
        command.Parameters.AddWithValue("$id", threadId);
        if (cutoffUs is long cutoff)
        {
            command.CommandText += " AND effective_us <= $cutoff";
            command.Parameters.AddWithValue("$cutoff", cutoff);
        }
        command.CommandText += " ORDER BY effective_us DESC, revision DESC LIMIT 1";
        using var row = command.ExecuteReader();
        return row.Read() ? new Note(row.IsDBNull(0) ? null : row.GetString(0), row.GetInt64(1)) : null;
    }

    private static Note? ReadLegacy(SqliteConnection connection, string threadId, long? cutoffUs = null)
    {
        using var command = connection.CreateCommand();
        command.CommandText = LegacyRevisions + """

            WHERE NOT EXISTS (SELECT 1 FROM memory_revisions WHERE thread_id = $id)
              AND ($cutoff IS NULL OR at <= $cutoff)
            ORDER BY at DESC, window DESC, is_current DESC, revision DESC LIMIT 1
            """;
        command.Parameters.AddWithValue("$id", threadId);
        command.Parameters.AddWithValue("$cutoff", cutoffUs is long cutoff
            ? DateTimeOffset.UnixEpoch.AddTicks(checked(cutoff * 10)).ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture)
            : DBNull.Value);
        using var row = command.ExecuteReader();
        return row.Read() ? new Note(row.GetString(0), TimestampUs(row.GetString(1))) : null;
    }

    internal static long TimestampUs(string? timestamp)
    {
        int time = timestamp?.IndexOf('T') ?? -1;
        if (timestamp is null || time < 0)
            throw new InvalidDataException("The note or fork timestamp is unavailable.");
        int zone = timestamp.AsSpan(time + 1).IndexOfAny('+', '-', 'Z');
        if (zone < 0)
            throw new InvalidDataException("The note or fork timestamp has no UTC offset.");
        zone += time + 1;
        int fraction = timestamp.AsSpan(time + 1, zone - time - 1).IndexOfAny('.', ',');
        if (fraction >= 0)
        {
            fraction += time + 1;
            int precision = Math.Min(6, zone - fraction - 1);
            // Python fromisoformat truncates the fractional seconds to microseconds.
            timestamp = timestamp[..fraction] + "." + timestamp.Substring(fraction + 1, precision) + timestamp[zone..];
        }
        if (!DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
            throw new InvalidDataException("Invalid note or fork timestamp.");
        return (parsed.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10;
    }
}
