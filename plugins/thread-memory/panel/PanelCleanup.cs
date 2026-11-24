using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using ThreadMemoryHook;
using Tomlyn;

namespace ThreadMemoryPanel;

internal static class PanelCleanup
{
    private static readonly string[] StateTables =
    [
        "handoffs", "handoff_history", "memory_revisions", "child_compactions", "reminder_claims",
        "rollout_scan_checkpoints", "hook_diagnostics",
    ];
    private static readonly string[] OptionalStateTables =
        ["reminder_delivery_policies", "reminder_deliveries", "reminder_compactions"];

    internal static JsonObject Run(string home, JsonElement args)
    {
        var store = new HookStore(home);
        bool confirm = args.ValueKind == JsonValueKind.Object && args.TryGetProperty("thread_ids", out _);
        string? warning = null;
        try
        {
            HashSet<string> candidates;
            if (confirm)
            {
                var requested = args.GetProperty("thread_ids");
                if (requested.ValueKind != JsonValueKind.Array)
                    return Unavailable("Expected a list of confirmed thread UUIDs.");
                candidates = requested.EnumerateArray().Select(PanelFiles.ThreadId).ToHashSet(StringComparer.Ordinal);
            }
            else
            {
                candidates = StoredThreads(store);
                try
                {
                    using var index = OpenSearchIndex(home, SqliteOpenMode.ReadOnly);
                    if (index is not null)
                        candidates.UnionWith(ThreadIds(index, "SELECT DISTINCT owner_thread_id FROM rollout_files"));
                }
                catch (Exception error) when (IsReadFailure(error))
                {
                    warning = "Could not read the rollout search index. Retry cleanup later.";
                }
            }

            int requestedCount = candidates.Count;
            RemoveIndexedThreads(home, candidates);
            PanelRollout[] rollouts = [];
            if (candidates.Count > 0)
            {
                candidates.ExceptWith(PanelFiles.SessionIndexThreads(home));
                if (candidates.Count > 0)
                {
                    rollouts = PanelFiles.LocalRollouts(home).ToArray();
                    foreach (var rollout in rollouts)
                    {
                        candidates.Remove(rollout.Owner);
                        candidates.Remove(rollout.Segment);
                    }
                }
            }

            var result = new JsonObject { ["status"] = "ok" };
            if (confirm)
            {
                int keptCount = 0;
                if (candidates.Count > 0)
                {
                    var (kept, reason) = PreserveForkSources(store, home, candidates, rollouts);
                    keptCount = kept.Count;
                    if (keptCount > 0)
                    {
                        candidates.ExceptWith(kept);
                        result["kept_thread_ids"] = IdArray(kept);
                        result["reason"] = reason;
                    }
                    // Unarchive can insert the index row and move the rollout behind the directory scan.
                    RemoveIndexedThreads(home, candidates);
                }

                int skippedCount = requestedCount - keptCount - candidates.Count;
                if (skippedCount > 0)
                    result["skipped_thread_count"] = skippedCount;

                int deleted = DeleteStoredThreads(store, candidates);
                try
                {
                    if (candidates.Count > 0)
                    {
                        using var index = OpenSearchIndex(home, SqliteOpenMode.ReadWrite);
                        if (index is not null)
                            deleted += DeleteThreads(index, ["rollout_files"], "owner_thread_id", candidates);
                    }
                }
                catch (Exception error) when (IsReadFailure(error))
                {
                    warning = "Could not clear the rollout search index. Retry cleanup later.";
                }
                result["deleted"] = deleted;
            }
            result["thread_ids"] = IdArray(candidates);
            if (warning is not null)
                result["index_warning"] = warning;
            return result;
        }
        catch (Exception error) when (IsReadFailure(error))
        {
            return Unavailable("Could not verify the local thread index or stored thread data.");
        }
    }

    private static void RemoveIndexedThreads(string home, HashSet<string> candidates)
    {
        if (candidates.Count == 0)
            return;
        string path = SessionFiles.ActiveStateDatabase(home)
            ?? throw new InvalidDataException("The Codex thread store is not local.");
        using var database = PanelFiles.OpenDatabase(path, SqliteOpenMode.ReadOnly);
        using var transaction = database.BeginTransaction(deferred: true);
        using var command = database.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT status FROM backfill_state WHERE id = 1";
        if (!Equals(command.ExecuteScalar(), "complete"))
            throw new InvalidDataException("The local Codex thread index has not finished backfilling.");

        var fields = new List<(string Table, string Column)>
        {
            ("threads", "id"), ("thread_spawn_edges", "child_thread_id"), ("thread_spawn_edges", "parent_thread_id"),
        };
        command.CommandText = "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'attached_thread_parent_id'";
        if (command.ExecuteScalar() is not null)
            fields.Add(("threads", "attached_thread_parent_id"));
        foreach (string[] batch in candidates.ToArray().Chunk(200))
        {
            command.Parameters.Clear();
            var parameters = new string[batch.Length];
            for (int i = 0; i < batch.Length; i++)
            {
                parameters[i] = $"$id{i}";
                command.Parameters.AddWithValue(parameters[i], batch[i]);
            }
            string list = string.Join(", ", parameters);
            command.CommandText = string.Join(" UNION ALL ", fields.Select(field =>
                $"SELECT {field.Column} FROM {field.Table} WHERE {field.Column} IN ({list})"));
            using var rows = command.ExecuteReader();
            while (rows.Read())
                candidates.Remove(rows.GetString(0));
        }
    }

    private static (HashSet<string> Kept, string Reason) PreserveForkSources(HookStore store, string home,
        HashSet<string> sources, IEnumerable<PanelRollout> rollouts)
    {
        var initialized = new HashSet<string>(StringComparer.Ordinal);
        var noteSources = new HashSet<string>(StringComparer.Ordinal);
        using (var database = store.OpenRead())
        {
            if (database is not null)
            {
                initialized = ThreadIds(database, "SELECT DISTINCT thread_id FROM memory_revisions");
                noteSources.UnionWith(initialized);
                noteSources.UnionWith(ThreadIds(database, """
                    SELECT thread_id FROM handoffs WHERE summary <> '' AND saved_at IS NOT NULL
                    UNION SELECT thread_id FROM handoff_history WHERE summary <> ''
                    """));
                noteSources.IntersectWith(sources);
            }
        }

        int uncertain = 0;
        var protectedNotes = new HashSet<string>(StringComparer.Ordinal);
        var attachedSources = new HashSet<string>(StringComparer.Ordinal);
        foreach (var group in rollouts.GroupBy(rollout => rollout.Owner, StringComparer.Ordinal))
        {
            (string? Id, bool Attached)? relation = null;
            foreach (var rollout in group.OrderBy(rollout => rollout.Owner != rollout.Segment)
                .ThenBy(rollout => rollout.Path.EndsWith(".zst", StringComparison.Ordinal)))
            {
                try
                {
                    relation = ReadParent(rollout);
                    break;
                }
                catch (Exception error) when (IsReadFailure(error))
                {
                    // A surviving revert may still identify the parent when the original cannot be read.
                }
            }
            if (relation is null)
            {
                uncertain++;
                continue;
            }
            if (relation.Value.Id is not string parent || !sources.Contains(parent))
                continue;
            if (relation.Value.Attached)
            {
                attachedSources.Add(parent);
                continue;
            }
            if (!noteSources.Contains(parent) || initialized.Contains(group.Key))
                continue;
            try
            {
                if (ThreadMemory.ReadForCli(store, home, group.Key, SessionFiles.ReadHeader) is null)
                    protectedNotes.Add(parent);
            }
            catch (Exception error) when (IsReadFailure(error) || error is ThreadMemory.InheritanceUnavailable
                or ThreadMemory.InvalidNoteRollout)
            {
                protectedNotes.Add(parent);
            }
        }

        var reasons = new List<string>();
        if (uncertain > 0 && noteSources.Count > 0)
        {
            protectedNotes.UnionWith(noteSources);
            reasons.Add($"Cannot verify fork lineage for {uncertain} local thread(s).");
        }
        else if (protectedNotes.Count > 0)
        {
            reasons.Add($"Could not preserve the fork-time note for {protectedNotes.Count} source thread(s).");
        }
        if (attachedSources.Count > 0)
            reasons.Add($"Surviving attached threads still reference {attachedSources.Count} source thread(s).");
        protectedNotes.UnionWith(attachedSources);
        return (protectedNotes, string.Join(' ', reasons));
    }

    private static (string? Id, bool Attached) ReadParent(PanelRollout rollout)
    {
        var header = PanelFiles.ReadHeader(rollout);
        var forkedFrom = SessionFiles.Property(header, "forked_from_id");
        bool attached = SessionFiles.Property(header, "attached_thread").ValueKind == JsonValueKind.True;
        if (forkedFrom.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
        {
            string parent = PanelFiles.ThreadId(forkedFrom);
            return !attached && ThreadMemory.IsSubagent(header) ? (null, false) : (parent, attached);
        }

        var historyBase = SessionFiles.Property(header, "history_base");
        if (attached || (historyBase.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null) &&
            PanelFiles.ThreadId(SessionFiles.Property(historyBase, "thread_id")) != rollout.Owner))
            throw new InvalidDataException("A rollout has an unverified fork parent.");
        return (null, false);
    }

    private static HashSet<string> StoredThreads(HookStore store)
    {
        using var database = store.OpenRead();
        return database is null ? new(StringComparer.Ordinal) : ThreadIds(database,
            string.Join(" UNION ", ExistingStateTables(database).Select(table => $"SELECT thread_id FROM {table}")));
    }

    private static HashSet<string> ThreadIds(SqliteConnection database, string query)
    {
        var identifiers = new HashSet<string>(StringComparer.Ordinal);
        using var command = database.CreateCommand();
        command.CommandText = query;
        using var rows = command.ExecuteReader();
        while (rows.Read())
        {
            if (rows.GetString(0) is not { Length: 36 } text || !Guid.TryParseExact(text, "D", out var id))
                throw new InvalidDataException("Saved thread data contains an invalid thread UUID.");
            identifiers.Add(id.ToString("D"));
        }
        return identifiers;
    }

    private static string[] ExistingStateTables(SqliteConnection database)
    {
        using var command = database.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table'";
        using var rows = command.ExecuteReader();
        var tables = new HashSet<string>(StringComparer.Ordinal);
        while (rows.Read())
            tables.Add(rows.GetString(0));
        return [.. StateTables, .. OptionalStateTables.Where(tables.Contains)];
    }

    private static int DeleteStoredThreads(HookStore store, HashSet<string> candidates)
    {
        if (candidates.Count == 0)
            return 0;
        using var database = store.OpenExisting(SqliteOpenMode.ReadWrite);
        return database is null ? 0 : DeleteThreads(database, ExistingStateTables(database), "thread_id", candidates);
    }

    private static int DeleteThreads(SqliteConnection database, IEnumerable<string> tables,
        string column, HashSet<string> candidates)
    {
        using var transaction = database.BeginTransaction(deferred: false);
        using var command = database.CreateCommand();
        command.Transaction = transaction;
        var identifier = command.Parameters.Add("$thread", SqliteType.Text);
        int removed = 0;
        foreach (string table in tables)
        {
            command.CommandText = $"DELETE FROM {table} WHERE {column} = $thread";
            foreach (string thread in candidates)
            {
                identifier.Value = thread;
                removed += command.ExecuteNonQuery();
            }
        }
        transaction.Commit();
        return removed;
    }

    private static SqliteConnection? OpenSearchIndex(string home, SqliteOpenMode mode)
    {
        string path = Path.Combine(home, "state", "plugins", "thread-memory", "rollout-index.sqlite3");
        try
        {
            File.GetAttributes(path);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        var database = PanelFiles.OpenDatabase(path, mode, foreignKeys: true);
        try
        {
            using var command = database.CreateCommand();
            command.CommandText = "PRAGMA user_version";
            if (!Equals(command.ExecuteScalar(), 1L))
                throw new InvalidDataException("Unsupported rollout index schema.");
            return database;
        }
        catch
        {
            database.Dispose();
            throw;
        }
    }

    private static bool IsReadFailure(Exception error) => error is IOException or UnauthorizedAccessException
        or InvalidDataException or ArgumentException or SqliteException or InvalidOperationException or JsonException or TomlException
        or NotSupportedException or FormatException;

    private static JsonArray IdArray(IEnumerable<string> ids) =>
        new(ids.Order(StringComparer.Ordinal).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());

    private static JsonObject Unavailable(string reason) => new()
        { ["status"] = "unavailable", ["thread_ids"] = new JsonArray(), ["reason"] = reason };
}
