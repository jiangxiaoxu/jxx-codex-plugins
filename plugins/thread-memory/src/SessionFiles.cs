using System.Buffers;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Tomlyn;
using Tomlyn.Model;
using ZstdSharp;

namespace ThreadMemoryHook;

internal static class SessionFiles
{
    private const int MaximumHeaderBytes = 4 * 1024 * 1024;
    private const string StateDatabaseName = "state_5.sqlite";

    internal static JsonElement ReadHeader(string path)
    {
        using var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (path.EndsWith(".zst", StringComparison.Ordinal))
        {
            try
            {
                using var decompressed = new DecompressionStream(source);
                return ReadFirstLine(decompressed);
            }
            catch (ZstdException)
            {
                return default;
            }
        }
        return ReadFirstLine(source);
    }

    private static JsonElement ReadFirstLine(Stream source)
    {
        byte[] buffer = new byte[4096];
        int read = source.Read(buffer);
        int lineEnd = buffer.AsSpan(0, read).IndexOf((byte)'\n');
        if (lineEnd >= 0)
            return ParseHeader(buffer.AsMemory(0, lineEnd));

        var header = new ArrayBufferWriter<byte>(buffer.Length);
        while (read > 0)
        {
            int length = lineEnd < 0 ? read : lineEnd;
            if (length > MaximumHeaderBytes - header.WrittenCount)
                return default;
            header.Write(buffer.AsSpan(0, length));
            if (lineEnd >= 0)
                break;
            read = source.Read(buffer);
            lineEnd = buffer.AsSpan(0, read).IndexOf((byte)'\n');
        }
        return ParseHeader(header.WrittenMemory);
    }

    private static JsonElement ParseHeader(ReadOnlyMemory<byte> line)
    {
        if (line.Span.StartsWith("\uFEFF"u8))
            line = line[3..];
        try
        {
            using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 128 });
            var envelope = document.RootElement;
            var type = Property(envelope, "type");
            var payload = Property(envelope, "payload");
            if (type.ValueKind != JsonValueKind.String || !type.ValueEquals("session_meta"u8)
                || payload.ValueKind != JsonValueKind.Object
                || Property(envelope, "timestamp").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String)
                || Property(envelope, "metadata").ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.Object)
                || !OptionalString(payload, "id") || !OptionalString(payload, "session_id")
                || !OptionalString(payload, "forked_from_id"))
                return default;
            return payload.Clone();
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            return default;
        }
    }

    private static bool OptionalString(JsonElement header, string name)
    {
        var property = Property(header, name);
        return property.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
            || property.ValueKind == JsonValueKind.String && property.GetString() is not null;
    }

    internal static JsonElement Property(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) ? value : default;

    internal static string? String(JsonElement obj, string name)
    {
        var value = Property(obj, name);
        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    internal static string? FindRollout(string home, string threadId, bool current = false)
    {
        if (current && IndexedPath(home, threadId) is { } indexed)
            return indexed;

        var directoryOptions = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = 0,
        };
        var matches = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string directory in new[] { Path.Combine(home, "sessions"), Path.Combine(home, "archived_sessions") })
        {
            if (!Directory.Exists(directory))
                continue;
            foreach (string candidate in Directory.EnumerateFiles(directory, $"rollout-*{threadId}*.jsonl*", directoryOptions))
            {
                string filename = Path.GetFileName(candidate);
                if (!TryRolloutName(filename, out string name, out string segmentId))
                    continue;
                int pageSeparator = name.IndexOf('_', 28);
                var owner = name.AsSpan(28, (pageSeparator < 0 ? name.Length : pageSeparator) - 28);
                if (current ? !owner.SequenceEqual(threadId) : segmentId != threadId)
                    continue;
                if (AvailablePath(candidate) is { } available)
                    matches.Add(available);
            }
        }

        if (matches.Count <= 1)
            return matches.FirstOrDefault();
        if (!current)
            throw new InvalidDataException($"Multiple local rollouts match {threadId}.");

        return matches.OrderBy(path => Path.GetFileName(path).Substring(8, 19), StringComparer.Ordinal)
            .ThenBy(path => SegmentId(path), StringComparer.Ordinal).ThenBy(path => path, StringComparer.Ordinal).Last();
    }

    private static string SegmentId(string path) =>
        TryRolloutName(Path.GetFileName(path), out _, out string id) ? id : string.Empty;

    private static bool TryRolloutName(string filename, out string name, out string id)
    {
        name = filename.EndsWith(".zst", StringComparison.Ordinal) ? filename[..^4] : filename;
        id = string.Empty;
        if (name.Length < 50 || !name.StartsWith("rollout-", StringComparison.Ordinal) || !name.EndsWith(".jsonl", StringComparison.Ordinal))
            return false;
        name = name[..^6];
        if (!Guid.TryParseExact(name.AsSpan(name.Length - 36), "D", out Guid uuid))
            return false;
        id = uuid.ToString("D");
        return true;
    }

    private static string? AvailablePath(string path)
    {
        string plain = path.EndsWith(".zst", StringComparison.Ordinal) ? path[..^4] : path;
        if (File.Exists(plain))
            return Path.GetFullPath(plain);
        return File.Exists(plain + ".zst") ? Path.GetFullPath(plain + ".zst") : null;
    }

    private static string? IndexedPath(string home, string threadId)
    {
        string? path;
        bool authoritative;
        try
        {
            string? database = ActiveStateDatabase(home);
            if (database is null || !File.Exists(database))
                return null;

            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = database,
                Mode = SqliteOpenMode.ReadOnly,
                DefaultTimeout = 1,
                Pooling = false,
            }.ToString());
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT count(*) FROM pragma_table_info('threads') WHERE name = 'history_mode'";
            string modeColumn = (long)command.ExecuteScalar()! > 0 ? "history_mode" : "'legacy'";
            command.CommandText = $"SELECT rollout_path, {modeColumn} FROM threads WHERE id = $id";
            command.Parameters.AddWithValue("$id", threadId);
            using var row = command.ExecuteReader();
            if (!row.Read())
                return null;
            authoritative = row.GetValue(1) is string mode && mode == "paginated";
            path = row.GetValue(0) as string;
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException or ArgumentException
            or NotSupportedException or TomlException or SqliteException)
        {
            return null;
        }

        try
        {
            if (!string.IsNullOrEmpty(path) && AvailablePath(path) is { } candidate
                && String(ReadHeader(candidate), "id") == threadId)
                return candidate;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            if (authoritative)
                throw new InvalidDataException($"Cannot read the indexed rollout for {threadId}.", error);
        }
        if (authoritative)
            throw new InvalidDataException($"Missing or invalid indexed rollout for {threadId}.");
        return null;
    }

    private static string? ActiveStateDatabase(string home)
    {
        TomlTable config;
        try
        {
            config = ReminderPlan.ReadConfig(home);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            config = new TomlTable();
        }
        if (config.TryGetValue("experimental_thread_store", out var store)
            && (store is not TomlTable storeTable || !storeTable.TryGetValue("type", out var type) || !Equals(type, "local")))
            return null;

        if (config.TryGetValue("sqlite_home", out var configured))
            return configured is string { Length: > 0 } root
                ? Path.Combine(home, ExpandUser(root), StateDatabaseName)
                : null;

        string? environment = Environment.GetEnvironmentVariable("CODEX_SQLITE_HOME")?.Trim();
        if (string.IsNullOrEmpty(environment))
            return Path.Combine(home, StateDatabaseName);
        environment = ExpandUser(environment);
        return Path.IsPathFullyQualified(environment) ? Path.Combine(environment, StateDatabaseName) : null;
    }

    private static string ExpandUser(string path)
    {
        string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (path == "~")
            return profile;
        return path.Length >= 2 && path[0] == '~' && path[1] is '/' or '\\'
            ? Path.Combine(profile, path[2..])
            : path;
    }
}
