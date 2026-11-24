using System.Buffers.Binary;
using System.Buffers.Text;
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
            WHERE thread_id = threads.thread_id AND summary <> ''
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

    private sealed record ListedNote(string ThreadId, string UpdatedAt, long SortAt);

    internal static JsonObject List(string home, JsonElement args)
    {
        int limit = 30;
        if (args.TryGetProperty("limit", out var limitArg)
            && (limitArg.ValueKind != JsonValueKind.Number || !limitArg.TryGetInt32(out limit) || limit is < 1 or > 100))
            throw new ArgumentException("Limit must be an integer between 1 and 100.");
        var anchor = args.TryGetProperty("cursor", out var cursorArg) ? DecodeCursor(cursorArg) : ((long SortAt, string ThreadId)?)null;
        var queryArg = SessionFiles.Property(args, "query");
        if (queryArg.ValueKind != JsonValueKind.Undefined
            && (queryArg.ValueKind != JsonValueKind.String || queryArg.GetString()!.EnumerateRunes().Count() > 256))
            throw new ArgumentException("Expected a handoff search query of at most 256 characters.");
        string query = Normalize(SessionFiles.String(args, "query"));
        string? archiveStatus = args.TryGetProperty("archive_status", out _) ? SessionFiles.String(args, "archive_status") : "all";
        if (archiveStatus is not ("all" or "active" or "archived"))
            throw new ArgumentException("Archive status must be all, active, or archived.");
        string? sort = args.TryGetProperty("sort_by", out _) ? SessionFiles.String(args, "sort_by") : "note_updated";
        if (sort is not ("note_updated" or "thread_updated"))
            throw new ArgumentException("Sort by must be note_updated or thread_updated.");

        var notes = ReadNoteTimes(new HookStore(home));
        var ids = notes.Select(note => note.ThreadId).ToHashSet(StringComparer.Ordinal);
        var indexed = ThreadMetadata(home, ids, IdentityColumns, withSpawnEdge: true);
        var archives = MainThreadArchives(home, ids, indexed);
        if (archiveStatus != "all")
        {
            bool archived = archiveStatus == "archived";
            foreach (var entry in archives.Where(entry => entry.Value != archived).ToArray())
                archives.Remove(entry.Key);
        }
        var titles = query.Length == 0
            ? new Dictionary<string, string>(StringComparer.Ordinal)
            : ThreadTitles(home, archives.Keys, ThreadMetadata(home, archives.Keys, TitleColumns));
        var ordered = notes.Where(note => archives.ContainsKey(note.ThreadId)
            && (query.Length == 0 || note.ThreadId.Contains(query, StringComparison.OrdinalIgnoreCase)
                || (titles.GetValueOrDefault(note.ThreadId)?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false)))
            .Select(note => sort == "thread_updated" && ThreadUpdatedAt(indexed.GetValueOrDefault(note.ThreadId)) is { } updated
                ? note with { SortAt = Microseconds(updated) }
                : note)
            .OrderByDescending(note => note.SortAt).ThenBy(note => note.ThreadId, StringComparer.Ordinal).ToArray();
        var afterAnchor = anchor is { } position
            ? ordered.SkipWhile(note => note.SortAt > position.SortAt || note.SortAt == position.SortAt
                && string.CompareOrdinal(note.ThreadId, position.ThreadId) <= 0)
            : ordered;
        var page = afterAnchor.Take(limit + 1).ToArray();
        var pageIds = page.Take(limit).Select(note => note.ThreadId).ToArray();
        var details = ThreadMetadata(home, pageIds, query.Length == 0 ? [.. PreviewColumns, .. TitleColumns] : PreviewColumns);
        if (query.Length == 0)
            titles = ThreadTitles(home, pageIds, details);
        JsonArray items = [];
        foreach (var note in page.Take(limit))
        {
            string id = note.ThreadId;
            string? title = titles.GetValueOrDefault(id);
            items.Add((JsonNode)new JsonObject
            {
                ["thread_id"] = id,
                ["latest_at"] = note.UpdatedAt,
                ["title"] = title is null ? null : Prefix(title, 160),
                ["preview"] = Preview(details.GetValueOrDefault(id)),
                ["archived"] = archives[id],
                ["thread_updated_at"] = ThreadUpdatedAt(indexed.GetValueOrDefault(id))?
                    .ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            });
        }
        return new JsonObject
        {
            ["items"] = items,
            ["next_cursor"] = page.Length > limit ? EncodeCursor(page[limit - 1]) : null,
            ["total"] = ordered.Length,
        };
    }

    internal static JsonObject Read(string home, JsonElement args)
    {
        string identifier = PanelFiles.ThreadId(SessionFiles.Property(args, "thread_id"));
        string? summary = null;
        string? updated = null;
        using var connection = new HookStore(home).OpenRead();
        if (connection is not null)
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                WITH threads AS (SELECT $id AS thread_id)
                SELECT COALESCE(memory.summary, handoff.summary), memory.updated_us, handoff.saved_at
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
        return new JsonObject { ["thread_id"] = identifier, ["summary"] = summary, ["updated_at"] = updated };
    }

    private static List<ListedNote> ReadNoteTimes(HookStore store)
    {
        using var connection = store.OpenRead();
        if (connection is null)
            return [];
        using var command = connection.CreateCommand();
        command.CommandText = """
            WITH threads AS (SELECT thread_id FROM memory_revisions UNION SELECT thread_id FROM handoffs)
            SELECT threads.thread_id, memory.updated_us, handoff.saved_at FROM threads
            """ + "\n" + NoteJoins + "\nWHERE memory.revision IS NOT NULL OR handoff.window IS NOT NULL";
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
                case true:
                    main[id] = row.GetValueOrDefault("archived") is 1L;
                    break;
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
                    if (SessionFiles.Property(header, "attached_thread").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.False)
                        || NonNullProperty(header, "parent_thread_id") || NonNullProperty(header, "subagent_history_start_ordinal")
                        || !string.IsNullOrEmpty(SessionFiles.String(header, "agent_role"))
                        || !string.IsNullOrEmpty(SessionFiles.String(header, "agent_nickname")))
                        continue;
                    var source = SessionFiles.Property(header, "source");
                    if (IsMainSource(source.ValueKind == JsonValueKind.Object ? source.GetRawText() : SessionFiles.String(header, "source"),
                        SessionFiles.String(header, "thread_source")) is not true)
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

    private static (long SortAt, string ThreadId) DecodeCursor(JsonElement argument)
    {
        Span<byte> bytes = stackalloc byte[24];
        if (argument.ValueKind != JsonValueKind.String || argument.GetString() is not { Length: 32 } cursor
            || !Base64Url.TryDecodeFromChars(cursor, bytes, out int written) || written != bytes.Length)
            throw new ArgumentException("Invalid thread list cursor. Start with the first page.");
        long rank = BinaryPrimitives.ReadInt64BigEndian(bytes);
        if (rank == long.MinValue)
            throw new ArgumentException("Invalid thread list cursor. Start with the first page.");
        return (-rank, new Guid(bytes[8..], bigEndian: true).ToString("D"));
    }

    private static string EncodeCursor(ListedNote last)
    {
        Span<byte> bytes = stackalloc byte[24];
        BinaryPrimitives.WriteInt64BigEndian(bytes, -last.SortAt);
        Guid.ParseExact(last.ThreadId, "D").TryWriteBytes(bytes[8..], bigEndian: true, out _);
        return Base64Url.EncodeToString(bytes);
    }
}
