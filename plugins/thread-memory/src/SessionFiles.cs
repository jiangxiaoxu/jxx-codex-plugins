using System.Text.Json;
using Microsoft.Data.Sqlite;
using Tomlyn;
using Tomlyn.Model;
using ZstdSharp;

namespace ThreadMemoryHook;

internal static class SessionFiles
{
    private const string StateDatabaseName = "state_5.sqlite";

    internal static JsonElement ReadHeader(string path)
    {
        using var source = OpenRead(path);
        return ReadHeader(path, source);
    }

    internal static JsonElement ReadHeader(string path, FileStream source)
    {
        if (path.EndsWith(".zst", StringComparison.Ordinal))
        {
            try
            {
                using var decompressed = new DecompressionStream(source, leaveOpen: true);
                using var header = RolloutHeader.Read(decompressed);
                return header?.Payload.Clone() ?? default;
            }
            catch (ZstdException)
            {
                return default;
            }
        }
        using var plain = RolloutHeader.Read(source);
        return plain?.Payload.Clone() ?? default;
    }

    internal static JsonElement Property(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var value) ? value : default;

    internal static string? String(JsonElement obj, string name)
    {
        var value = Property(obj, name);
        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    internal static string? FindRollout(string home, string threadId, bool current = false,
        Func<string, JsonElement>? readHeader = null)
    {
        if (current && IndexedPath(home, threadId, readHeader ?? ReadHeader) is { } indexed)
            return indexed;

        var directoryOptions = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = 0,
        };
        var matches = new Dictionary<(ulong Device, UInt128 Inode, string? Path), string>();
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
                if (current ? !owner.Equals(threadId, StringComparison.OrdinalIgnoreCase) : segmentId != threadId)
                    continue;
                if (AvailablePath(candidate) is not { } available)
                    continue;
                try
                {
                    using var stream = OpenRead(available);
                    var rollout = RolloutPath.Resolve(available, stream);
                    var key = (rollout.Stat.Device, rollout.Stat.Inode, rollout.Stat.Inode == 0 ? rollout.Key : null);
                    if (!matches.TryGetValue(key, out string? existing) || CompareCandidates(available, existing) > 0)
                        matches[key] = available;
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    // Archiving can move a file between enumeration and opening it.
                }
            }
        }

        if (matches.Count <= 1)
            return matches.Values.FirstOrDefault();
        if (!current)
            throw new InvalidDataException($"Multiple local rollouts match {threadId}.");

        return matches.Values.MaxBy(path => path, Comparer<string>.Create(CompareCandidates));
    }

    private static int CompareCandidates(string left, string right)
    {
        int dateOrder = Path.GetFileName(left).AsSpan(8, 19).SequenceCompareTo(Path.GetFileName(right).AsSpan(8, 19));
        if (dateOrder != 0)
            return dateOrder;
        int segmentOrder = string.CompareOrdinal(SegmentId(left), SegmentId(right));
        return segmentOrder != 0 ? segmentOrder : string.CompareOrdinal(left, right);
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
            return plain;
        return File.Exists(plain + ".zst") ? plain + ".zst" : null;
    }

    private static FileStream OpenRead(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

    private static string? IndexedPath(string home, string threadId, Func<string, JsonElement> readHeader)
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
                && String(readHeader(candidate), "id") == threadId)
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

    internal static string? ActiveStateDatabase(string home)
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
