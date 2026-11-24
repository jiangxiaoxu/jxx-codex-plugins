using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using ThreadMemoryHook;
using Tomlyn;

namespace ThreadMemoryPanel;

internal static class PanelThreads
{
    private static readonly string[] IdentityColumns =
        ["source", "thread_source", "agent_role", "agent_nickname", "attached_thread_parent_id", "archived", "updated_at_ms", "updated_at"];
    private static readonly string[] TitleColumns = ["name", "title"];
    private static readonly string[] PreviewColumns = ["preview", "first_user_message"];

    private const string NoteJoins = """
        LEFT JOIN memory_revisions AS memory ON memory.revision = (
            SELECT revision FROM memory_revisions
            WHERE thread_id = threads.thread_id
            ORDER BY effective_us DESC, revision DESC LIMIT 1
        )
        LEFT JOIN handoffs AS handoff ON memory.revision IS NULL
            AND handoff.thread_id = threads.thread_id AND handoff.window = (
                SELECT window FROM handoffs
                WHERE thread_id = threads.thread_id AND summary <> '' AND saved_at IS NOT NULL
                ORDER BY CASE LENGTH(saved_at)
                    WHEN 20 THEN SUBSTR(saved_at, 1, 19) || '.000000Z'
                    WHEN 24 THEN SUBSTR(saved_at, 1, 23) || '000Z'
                    ELSE saved_at
                END DESC, window LIMIT 1
            )
        """;

    private sealed record ListedNote(string ThreadId, string UpdatedAt, long SortAt, bool Inherited = false);
    private sealed record SpawnLink(string ParentId, bool Indexed, bool Attached);

    private static (int Limit, int Page, string Query) ListArguments(JsonElement args)
    {
        int limit = 30;
        if (args.TryGetProperty("limit", out var limitArg)
            && (limitArg.ValueKind != JsonValueKind.Number || !limitArg.TryGetInt32(out limit) || limit is < 1 or > 100))
            throw new ArgumentException("Limit must be an integer between 1 and 100.");
        int pageNumber = 1;
        if (args.TryGetProperty("page", out var pageArg)
            && (pageArg.ValueKind != JsonValueKind.Number || !pageArg.TryGetInt32(out pageNumber) || pageNumber < 1))
            throw new ArgumentException("Page must be a positive integer.");
        var queryArg = SessionFiles.Property(args, "query");
        if (queryArg.ValueKind != JsonValueKind.Undefined
            && (queryArg.ValueKind != JsonValueKind.String || queryArg.GetString()!.EnumerateRunes().Count() > 256))
            throw new ArgumentException("Expected a handoff search query of at most 256 characters.");
        return (limit, pageNumber, Normalize(SessionFiles.String(args, "query")));
    }

    internal static JsonObject List(string home, JsonElement args)
    {
        var (limit, pageNumber, query) = ListArguments(args);
        string? archiveStatus = args.TryGetProperty("archive_status", out _) ? SessionFiles.String(args, "archive_status") : "all";
        if (archiveStatus is not ("all" or "active" or "archived"))
            throw new ArgumentException("Archive status must be all, active, or archived.");
        string? sort = args.TryGetProperty("sort_by", out _) ? SessionFiles.String(args, "sort_by") : "note_updated";
        if (sort is not ("note_updated" or "thread_updated"))
            throw new ArgumentException("Sort by must be note_updated or thread_updated.");
        string? selected = args.TryGetProperty("selected_thread_id", out var selectedArg) ? PanelFiles.ThreadId(selectedArg) : null;

        var notes = ReadNoteTimes(new HookStore(home));
        var links = ReadSpawnLinks(home);
        Dictionary<string, (ListedNote Latest, int ChildCount)> groups = new(StringComparer.Ordinal);
        foreach (var note in notes ?? [])
        {
            string id = note.ThreadId;
            var child = links?.GetValueOrDefault(id);
            string? root = links is null ? id : RootOf(id, links);
            if (child is { Indexed: false } || root is null)
                continue;
            int childCount = child is null ? 0 : 1;
            if (groups.TryGetValue(root, out var group))
                groups[root] = (group.Latest.SortAt >= note.SortAt ? group.Latest : note,
                    group.ChildCount + childCount);
            else
                groups[root] = (note, childCount);
        }
        var ids = groups.Keys.ToHashSet(StringComparer.Ordinal);
        if (selected is not null)
            ids.Add(selected);
        var indexed = ThreadMetadata(home, ids, IdentityColumns, withSpawnEdge: true);
        var archives = MainThreadArchives(home, ids, indexed);
        bool? selectedArchived = selected is not null && archives.TryGetValue(selected, out bool selectedValue) ? selectedValue : null;
        bool? selectedAvailable = null;
        if (selected is not null && notes is not null)
        {
            if (groups.ContainsKey(selected))
                selectedAvailable = selectedArchived.HasValue ? true : null;
            else if (links is not null)
                selectedAvailable = false;
        }
        bool? archiveFilter = archiveStatus == "all" ? null : archiveStatus == "archived";
        var matchingIds = groups.Keys.Where(id => archives.TryGetValue(id, out bool archived)
            && (archiveFilter is null || archived == archiveFilter)).ToArray();
        var titles = query.Length == 0
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : ThreadTitles(home, matchingIds, ThreadMetadata(home, matchingIds, TitleColumns));
        var ordered = matchingIds.Where(id => Matches(query, id, titles))
            .OrderByDescending(id => sort == "thread_updated" && ThreadUpdatedAt(indexed.GetValueOrDefault(id)) is { } updated
                ? Microseconds(updated) : groups[id].Latest.SortAt)
            .ThenBy(id => id, StringComparer.Ordinal).ToArray();
        var response = Page(ordered, pageNumber, limit, page =>
        {
            var details = ThreadMetadata(home, page, query.Length == 0 ? [.. PreviewColumns, .. TitleColumns] : PreviewColumns);
            if (query.Length == 0)
                titles = ThreadTitles(home, page, details);
            JsonArray items = [];
            foreach (string id in page)
            {
                var group = groups[id];
                items.Add((JsonNode)new JsonObject
                {
                    ["thread_id"] = id,
                    ["latest_at"] = group.Latest.UpdatedAt,
                    ["title"] = titles.GetValueOrDefault(id) is { } title ? Prefix(title, 160) : null,
                    ["preview"] = Preview(details.GetValueOrDefault(id)),
                    ["archived"] = archives[id],
                    ["thread_updated_at"] = ThreadUpdatedAt(indexed.GetValueOrDefault(id))?
                        .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                    ["child_note_count"] = links is null ? null : JsonValue.Create(group.ChildCount),
                });
            }
            return items;
        });
        response["selected_archived"] = selectedArchived;
        response["selected_available"] = selectedAvailable;
        response["spawn_index_available"] = links is not null;
        response["note_store_available"] = notes is not null;
        return response;
    }

    internal static JsonObject ListChildren(string home, JsonElement args)
    {
        string root = PanelFiles.ThreadId(SessionFiles.Property(args, "thread_id"));
        var (limit, pageNumber, query) = ListArguments(args);
        var include = SessionFiles.Property(args, "include_inherited");
        if (include.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.True or JsonValueKind.False))
            throw new ArgumentException("Include inherited must be a boolean.");
        var links = ReadSpawnLinks(home);
        if (links is null)
        {
            var unavailable = Page(Array.Empty<ListedNote>(), pageNumber, limit, _ => []);
            unavailable["can_include_inherited"] = false;
            unavailable["spawn_index_available"] = false;
            unavailable["inheritance_status"] = "unavailable";
            return unavailable;
        }
        // Only expose a spawn subtree from an independently verified main thread.
        bool main = !links.ContainsKey(root)
            && MainThreadArchives(home, [root], ThreadMetadata(home, [root], IdentityColumns)).ContainsKey(root);
        bool includeInherited = include.ValueKind == JsonValueKind.True;
        var (ancestorCutoffs, inheritanceStatus) = main ? ForkCutoffs(home, root, links, directOnly: !includeInherited) : ([], "unavailable");
        List<ListedNote> notes = [];
        bool noteStoreAvailable = true;
        if (main && links.Count > 0)
        {
            var store = new HookStore(home);
            var ownNotes = ReadNoteTimes(store);
            noteStoreAvailable = ownNotes is not null;
            notes.AddRange((ownNotes ?? []).Where(note =>
                links.TryGetValue(note.ThreadId, out var link) && link.Indexed && RootOf(note.ThreadId, links) == root));
            if (includeInherited && ancestorCutoffs.Count > 0 && store.OpenRead() is { } connection)
            {
                using (connection)
                {
                    foreach (string id in HistoricalNoteIds(connection, ancestorCutoffs.Values.Max()))
                        if (links.TryGetValue(id, out var link) && link.Indexed && RootOf(id, links) is { } ancestor
                            && ancestorCutoffs.TryGetValue(ancestor, out long cutoff)
                            && HistoricalChild(connection, id, cutoff) is { } historical)
                            notes.Add(new ListedNote(id, NoteTimestamp(historical.UpdatedUs), historical.UpdatedUs, Inherited: true));
                }
            }
        }
        Dictionary<string, string> titles = new(StringComparer.Ordinal);
        if (query.Length != 0)
            foreach (var (id, row) in ThreadMetadata(home, notes.Select(note => note.ThreadId), ["agent_path"]))
                if (ChildPath(row) is { } path)
                    titles[id] = path;
        var ordered = notes.Where(note => Matches(query, note.ThreadId, titles))
            .OrderByDescending(note => note.SortAt).ThenBy(note => note.ThreadId, StringComparer.Ordinal).ToArray();
        var response = Page(ordered, pageNumber, limit, page =>
        {
            var ids = page.Select(note => note.ThreadId).ToArray();
            var details = ThreadMetadata(home, ids, query.Length == 0
                ? [.. PreviewColumns, "archived", "agent_path"] : [.. PreviewColumns, "archived"]);
            JsonArray items = [];
            foreach (var note in page)
            {
                string id = note.ThreadId;
                var metadata = details.GetValueOrDefault(id);
                items.Add((JsonNode)new JsonObject
                {
                    ["thread_id"] = id,
                    ["parent_thread_id"] = links[id].ParentId,
                    ["latest_at"] = note.UpdatedAt,
                    ["title"] = query.Length == 0 ? ChildPath(metadata) : titles.GetValueOrDefault(id),
                    ["preview"] = note.Inherited ? null : Preview(metadata),
                    ["archived"] = metadata?.GetValueOrDefault("archived") is 1L,
                    ["inherited"] = note.Inherited,
                });
            }
            return items;
        });
        response["can_include_inherited"] = ancestorCutoffs.Count > 0;
        response["spawn_index_available"] = true;
        response["note_store_available"] = noteStoreAvailable;
        response["inheritance_status"] = inheritanceStatus;
        return response;
    }

    private static bool Matches(string query, string id, Dictionary<string, string> titles) => query.Length == 0
        || id.Contains(query, StringComparison.OrdinalIgnoreCase)
        || (titles.GetValueOrDefault(id)?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false);

    private static JsonObject Page<T>(T[] ordered, int pageNumber, int limit, Func<T[], JsonArray> project)
    {
        int totalPages = ordered.Length == 0 ? 1 : (ordered.Length - 1) / limit + 1;
        pageNumber = Math.Min(pageNumber, totalPages);
        return new JsonObject
        {
            ["items"] = project(ordered.Skip((pageNumber - 1) * limit).Take(limit).ToArray()),
            ["page"] = pageNumber,
            ["total_pages"] = totalPages,
            ["total"] = ordered.Length,
        };
    }

    internal static JsonObject Read(string home, JsonElement args)
    {
        string identifier = PanelFiles.ThreadId(SessionFiles.Property(args, "thread_id"));
        var forkArg = SessionFiles.Property(args, "from_fork");
        string? fork = forkArg.ValueKind == JsonValueKind.Undefined ? null : PanelFiles.ThreadId(forkArg);
        string? summary = null;
        string? updated = null;
        using var connection = new HookStore(home).OpenRead();
        if (fork is not null)
        {
            var links = ReadSpawnLinks(home)
                ?? throw new InvalidDataException("The Codex subagent index is unavailable. Refresh the panel or try again later.");
            if (links.TryGetValue(identifier, out var link) && link.Indexed
                && RootOf(identifier, links) is { } ancestor && ancestor != fork)
            {
                var (cutoffs, status) = ForkCutoffs(home, fork, links);
                if (cutoffs.TryGetValue(ancestor, out long cutoff))
                {
                    if (connection is not null && HistoricalChild(connection, identifier, cutoff) is { } historical)
                    {
                        summary = historical.Summary;
                        updated = NoteTimestamp(historical.UpdatedUs);
                    }
                }
                else if (status is "partial" or "unavailable")
                    throw new InvalidDataException("The fork ancestry could not be fully verified. Refresh the panel or try again later.");
            }
        }
        else if (connection is not null)
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                WITH threads AS (SELECT $id AS thread_id)
                SELECT COALESCE(NULLIF(memory.summary, ''), handoff.summary), memory.updated_us, handoff.saved_at
                FROM threads
                """ + "\n" + NoteJoins;
            command.Parameters.AddWithValue("$id", identifier);
            using var row = command.ExecuteReader();
            if (row.Read() && !row.IsDBNull(0))
            {
                summary = row.GetString(0);
                updated = row.IsDBNull(1) ? row.GetString(2) : NoteTimestamp(row.GetInt64(1));
            }
        }
        return new JsonObject
        {
            ["thread_id"] = identifier,
            ["summary"] = summary,
            ["updated_at"] = updated,
            ["note_available"] = connection is null ? null : JsonValue.Create(!string.IsNullOrEmpty(summary)),
        };
    }

    private static List<ListedNote>? ReadNoteTimes(HookStore store)
    {
        using var connection = store.OpenRead();
        if (connection is null)
            return null;
        using var command = connection.CreateCommand();
        command.CommandText = """
            WITH threads AS (SELECT thread_id FROM memory_revisions UNION SELECT thread_id FROM handoffs)
            SELECT threads.thread_id, memory.updated_us, handoff.saved_at FROM threads
            """ + "\n" + NoteJoins + "\nWHERE memory.summary <> '' OR handoff.window IS NOT NULL";
        using var reader = command.ExecuteReader();
        List<ListedNote> notes = [];
        while (reader.Read())
        {
            string id = reader.GetString(0);
            if (id.Length != 36 || !Guid.TryParseExact(id, "D", out _))
                continue;
            if (reader.IsDBNull(1))
            {
                string saved = reader.GetString(2);
                notes.Add(new ListedNote(id, saved, ThreadMemory.TimestampUs(saved)));
            }
            else
            {
                long saved = reader.GetInt64(1);
                notes.Add(new ListedNote(id, NoteTimestamp(saved), saved));
            }
        }
        return notes;
    }

    private static Dictionary<string, SpawnLink>? ReadSpawnLinks(string home)
    {
        Dictionary<string, SpawnLink> links = new(StringComparer.Ordinal);
        try
        {
            if (SessionFiles.ActiveStateDatabase(home) is not { } database || !File.Exists(database))
                return null;
            using var connection = PanelFiles.OpenDatabase(database, SqliteOpenMode.ReadOnly);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT status FROM backfill_state WHERE id = 1";
            if (!Equals(command.ExecuteScalar(), "complete"))
                return null;
            command.CommandText = "SELECT COUNT(*) FROM pragma_table_info('thread_spawn_edges') WHERE name IN ('parent_thread_id', 'child_thread_id')";
            if (command.ExecuteScalar() is not 2L)
                return null;
            command.CommandText = "SELECT 1 FROM pragma_table_info('threads') WHERE name = 'attached_thread_parent_id'";
            var attached = command.ExecuteScalar() is 1L
                ? "NULLIF(threads.attached_thread_parent_id, '') IS NOT NULL" : "0";
            command.CommandText = $"""
                SELECT edge.child_thread_id, edge.parent_thread_id, threads.id IS NOT NULL, {attached}
                FROM thread_spawn_edges AS edge LEFT JOIN threads ON threads.id = edge.child_thread_id
                """;
            using var reader = command.ExecuteReader();
            while (reader.Read())
                links[reader.GetString(0)] = new SpawnLink(reader.GetString(1), reader.GetBoolean(2), reader.GetBoolean(3));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
            or NotSupportedException or TomlException or SqliteException or InvalidDataException or InvalidOperationException)
        {
            return null;
        }
        return links;
    }

    private static string? RootOf(string id, Dictionary<string, SpawnLink> links)
    {
        if (!links.TryGetValue(id, out var link))
            return id;
        HashSet<string> visited = new(StringComparer.Ordinal);
        do
        {
            if (link.Attached || !visited.Add(id))
                return null;
            id = link.ParentId;
        }
        while (links.TryGetValue(id, out link));
        return id;
    }

    private static ThreadMemory.Note? HistoricalChild(SqliteConnection connection, string id, long cutoff)
    {
        // A saved revision at this cutoff also establishes that the child already existed.
        var saved = ThreadMemory.ReadSavedAt(connection, id, cutoff);
        return string.IsNullOrEmpty(saved?.Summary) ? null : saved;
    }

    private static List<string> HistoricalNoteIds(SqliteConnection connection, long latestCutoff)
    {
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT thread_id FROM memory_revisions WHERE effective_us <= $cutoff AND summary <> ''
            UNION SELECT thread_id FROM handoffs WHERE saved_at IS NOT NULL AND summary <> ''
            UNION SELECT thread_id FROM handoff_history WHERE summary <> ''
            """;
        command.Parameters.AddWithValue("$cutoff", latestCutoff);
        using var reader = command.ExecuteReader();
        List<string> ids = [];
        while (reader.Read())
            ids.Add(reader.GetString(0));
        return ids;
    }

    private static (Dictionary<string, long> Cutoffs, string Status) ForkCutoffs(string home, string root,
        Dictionary<string, SpawnLink> links,
        bool directOnly = false)
    {
        Dictionary<string, long> cutoffs = new(StringComparer.Ordinal);
        var rollouts = new PanelForkRollouts(home);
        var header = MainHeader(root);
        long cutoff = long.MaxValue;
        while (header.ValueKind == JsonValueKind.Object)
        {
            var forkedFrom = SessionFiles.Property(header, "forked_from_id");
            if (forkedFrom.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                return (cutoffs, cutoffs.Count == 0 ? "none" : "available");
            if (forkedFrom.ValueKind != JsonValueKind.String || forkedFrom.GetString() is not { Length: 36 } parentText
                || !Guid.TryParseExact(parentText, "D", out var parentId))
                break;
            string parent = parentId.ToString("D");
            if (parent == root || cutoffs.ContainsKey(parent))
                return ([], "unavailable");
            if (directOnly && cutoffs.Count != 0)
                return (cutoffs, "available");
            try
            {
                cutoff = Math.Min(cutoff, ThreadMemory.TimestampUs(SessionFiles.String(header, "timestamp")));
            }
            catch (InvalidDataException)
            {
                break;
            }
            var parentHeader = MainHeader(parent);
            if (parentHeader.ValueKind == JsonValueKind.Undefined)
                break;
            cutoffs[parent] = cutoff;
            header = parentHeader;
        }
        return (cutoffs, cutoffs.Count == 0 ? "unavailable" : "partial");

        JsonElement MainHeader(string id)
        {
            if (links.ContainsKey(id))
                return default;
            var metadata = ThreadMetadata(home, [id], ["rollout_path"]);
            var header = rollouts.ReadHeader(id, metadata.GetValueOrDefault(id)?.GetValueOrDefault("rollout_path") as string);
            return IsMainHeader(header) ? header : default;
        }
    }

    private static Dictionary<string, Dictionary<string, object?>> ThreadMetadata(string home, IEnumerable<string> ids,
        string[] columns, bool withSpawnEdge = false)
    {
        string[] threadIds = ids.Order(StringComparer.Ordinal).ToArray();
        Dictionary<string, Dictionary<string, object?>> metadata = new(StringComparer.Ordinal);
        if (threadIds.Length == 0)
            return metadata;
        try
        {
            if (SessionFiles.ActiveStateDatabase(home) is not { } database || !File.Exists(database))
                return metadata;
            using var connection = PanelFiles.OpenDatabase(database, SqliteOpenMode.ReadOnly);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT name FROM pragma_table_info('threads')";
            HashSet<string> schema = new(StringComparer.Ordinal);
            using (var reader = command.ExecuteReader())
                while (reader.Read())
                    schema.Add(reader.GetString(0));
            if (!schema.Contains("id"))
                return metadata;
            List<string> projection = ["id"];
            projection.AddRange(columns.Where(schema.Contains).Select(column => column is "preview" or "first_user_message"
                ? $"substr({column}, 1, 512) AS {column}" : column));
            if (withSpawnEdge)
            {
                command.CommandText = "SELECT count(*) FROM pragma_table_info('thread_spawn_edges') WHERE name = 'child_thread_id'";
                if (command.ExecuteScalar() is long count && count != 0)
                    projection.Add("EXISTS (SELECT 1 FROM thread_spawn_edges WHERE child_thread_id = threads.id) AS spawned");
            }
            foreach (string[] batch in threadIds.Chunk(200))
            {
                command.Parameters.Clear();
                var names = new string[batch.Length];
                for (int i = 0; i < batch.Length; i++)
                {
                    names[i] = "$id" + i.ToString(CultureInfo.InvariantCulture);
                    command.Parameters.AddWithValue(names[i], batch[i]);
                }
                command.CommandText = $"SELECT {string.Join(", ", projection)} FROM threads WHERE id IN ({string.Join(", ", names)})";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    Dictionary<string, object?> row = new(StringComparer.Ordinal);
                    for (int i = 1; i < reader.FieldCount; i++)
                        if (!reader.IsDBNull(i))
                            row[reader.GetName(i)] = reader.GetValue(i);
                    metadata[reader.GetString(0)] = row;
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException
            or NotSupportedException or TomlException or SqliteException or InvalidDataException)
        {
            metadata.Clear();
        }
        return metadata;
    }

    private static Dictionary<string, bool> MainThreadArchives(string home, HashSet<string> ids,
        Dictionary<string, Dictionary<string, object?>> metadata)
    {
        Dictionary<string, bool> main = new(StringComparer.Ordinal);
        var unknown = ids.Where(id => !metadata.ContainsKey(id)).ToHashSet(StringComparer.Ordinal);
        foreach (var (id, row) in metadata)
        {
            if (Present(row, "attached_thread_parent_id") || Present(row, "agent_role") || Present(row, "agent_nickname")
                || row.GetValueOrDefault("spawned") is 1L)
                continue;
            switch (IsMainSource(row.GetValueOrDefault("source") as string, row.GetValueOrDefault("thread_source") as string))
            {
                case true when row.GetValueOrDefault("archived") is long archiveFlag:
                    main[id] = archiveFlag == 1;
                    break;
                case true:
                case null:
                    unknown.Add(id);
                    break;
            }
        }
        if (unknown.Count == 0)
            return main;

        try
        {
            foreach (var rollout in PanelFiles.LocalRollouts(home))
            {
                string owner = rollout.Owner;
                if (!unknown.Contains(owner))
                    continue;
                try
                {
                    var header = PanelFiles.ReadHeader(rollout);
                    var session = SessionFiles.Property(header, "session_id");
                    if (session.ValueKind != JsonValueKind.Undefined
                        && (session.ValueKind != JsonValueKind.String || session.GetString() is not { Length: 36 } id
                            || !Guid.TryParseExact(id, "D", out var sessionId) || sessionId.ToString("D") != owner))
                        continue;
                    if (!IsMainHeader(header))
                        continue;
                    string relative = Path.GetRelativePath(Path.Combine(home, "archived_sessions"), rollout.Path);
                    bool archived = !Path.IsPathRooted(relative) && relative != ".."
                        && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
                    main[owner] = archived || metadata.GetValueOrDefault(owner)?.GetValueOrDefault("archived") is 1L;
                    if (unknown.Remove(owner) && unknown.Count == 0)
                        break;
                }
                catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException
                    or ArgumentException or InvalidOperationException or JsonException)
                {
                    // An unreadable header cannot establish that an unknown thread belongs in the list.
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidDataException)
        {
            // Already verified rows remain usable if a session directory cannot be read.
        }
        return main;
    }

    private static bool IsMainHeader(JsonElement header)
    {
        if (SessionFiles.Property(header, "attached_thread").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.False)
            || ThreadMemory.IsSubagent(header) || NonNullProperty(header, "parent_thread_id")
            || !string.IsNullOrEmpty(SessionFiles.String(header, "agent_role"))
            || !string.IsNullOrEmpty(SessionFiles.String(header, "agent_nickname")))
            return false;
        var source = SessionFiles.Property(header, "source");
        return IsMainSource(source.ValueKind == JsonValueKind.Object ? source.GetRawText() : SessionFiles.String(header, "source"),
            SessionFiles.String(header, "thread_source")) is true;
    }

    private static bool? IsMainSource(string? source, string? threadSource)
    {
        if (threadSource is "subagent" or "guardian_review" or "memory_consolidation")
            return false;
        if (source?.StartsWith('{') is true)
        {
            try
            {
                using var json = JsonDocument.Parse(source);
                if (json.RootElement.TryGetProperty("subagent", out _) || json.RootElement.TryGetProperty("internal", out _))
                    return false;
                if (json.RootElement.TryGetProperty("custom", out var custom) && custom.ValueKind == JsonValueKind.String
                    && json.RootElement.EnumerateObject().Count() == 1)
                    return true;
            }
            catch (JsonException) { return null; }
        }
        if (source is "subagent" or "internal" || source?.StartsWith("subagent_", StringComparison.Ordinal) is true
            || source?.StartsWith("internal_", StringComparison.Ordinal) is true)
            return false;
        if (source is "cli" or "vscode" or "exec" or "mcp" || threadSource == "user")
            return true;
        return null;
    }

    private static bool Present(Dictionary<string, object?> row, string column) => row.GetValueOrDefault(column) switch
    {
        string text => text.Length != 0,
        long number => number != 0,
        null => false,
        _ => true,
    };

    private static bool NonNullProperty(JsonElement header, string field) =>
        SessionFiles.Property(header, field).ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null);

    private static Dictionary<string, string> ThreadTitles(string home, IEnumerable<string> ids,
        Dictionary<string, Dictionary<string, object?>> metadata)
    {
        Dictionary<string, string> titles = new(StringComparer.Ordinal);
        HashSet<string> unnamed = new(StringComparer.Ordinal);
        foreach (string id in ids)
        {
            string name = DisplayText(metadata.GetValueOrDefault(id)?.GetValueOrDefault("name") as string);
            if (name.Length == 0)
                unnamed.Add(id);
            else
                titles[id] = name;
        }
        if (unnamed.Count == 0)
            return titles;

        try
        {
            using var file = new FileStream(Path.Combine(home, "session_index.jsonl"), FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(file);
            while (reader.ReadLine() is { } line)
            {
                try
                {
                    using var row = JsonDocument.Parse(line);
                    if (SessionFiles.String(row.RootElement, "id") is { } id && unnamed.Contains(id)
                        && DisplayText(SessionFiles.String(row.RootElement, "thread_name")) is { Length: > 0 } name)
                        titles[id] = name;
                }
                catch (Exception error) when (error is JsonException or InvalidOperationException)
                {
                    // Skip unreadable rows, including an incomplete append.
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }

        foreach (string id in unnamed)
            if (!titles.ContainsKey(id) && DisplayText(metadata.GetValueOrDefault(id)?.GetValueOrDefault("title") as string) is { Length: > 0 } title)
                titles[id] = title;
        return titles;
    }

    private static string? ChildPath(Dictionary<string, object?>? metadata) =>
        DisplayText(metadata?.GetValueOrDefault("agent_path") as string) is { Length: > 0 } path ? path : null;

    private static string? Preview(Dictionary<string, object?>? row)
    {
        foreach (string column in PreviewColumns)
        {
            string text = DisplayText(row?.GetValueOrDefault(column) as string);
            if (text.Length == 0)
                continue;
            if (Prefix(text, 200).Length == text.Length)
                return text;
            string prefix = Prefix(text, 197);
            int boundary = prefix.LastIndexOf(' ');
            return (boundary >= 160 && prefix[..boundary].EnumerateRunes().Count() >= 160 ? prefix[..boundary] : prefix) + "...";
        }
        return null;
    }

    private static string Normalize(string? text) => text is null ? "" : string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string DisplayText(string? text) => text is null ? "" : Normalize(MediaText.OmitDataUrls(text));

    private static string Prefix(string text, int count)
    {
        int length = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            if (count-- == 0)
                return text[..length];
            length += rune.Utf16SequenceLength;
        }
        return text;
    }

    private static DateTimeOffset? ThreadUpdatedAt(Dictionary<string, object?>? row)
    {
        if (row?.GetValueOrDefault("updated_at_ms") is long ms && ms is >= -62135596800000L and <= 253402300799999L)
            return DateTimeOffset.FromUnixTimeMilliseconds(ms);
        if (row?.GetValueOrDefault("updated_at") is long seconds && seconds is >= -62135596800L and <= 253402300799L)
            return DateTimeOffset.FromUnixTimeSeconds(seconds);
        return null;
    }

    private static string NoteTimestamp(long microseconds) => DateTimeOffset.UnixEpoch.AddTicks(checked(microseconds * 10))
        .ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    private static long Microseconds(DateTimeOffset timestamp) => (timestamp.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks) / 10;
}
