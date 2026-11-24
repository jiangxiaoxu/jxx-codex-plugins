using System.Text.Json;
using ThreadMemoryHook;

namespace ThreadMemoryPanel;

internal sealed class PanelForkRollouts(string home)
{
    private readonly string[] directories = [Path.Combine(home, "sessions"), Path.Combine(home, "archived_sessions")];
    private ILookup<string, string>? originals;

    internal JsonElement ReadHeader(string id, string? indexedPath)
    {
        if (indexedPath is not null && ReadIndexedHeader(indexedPath, id) is { ValueKind: JsonValueKind.Object } indexed)
            return indexed;
        try
        {
            originals ??= FindOriginalPaths();
            string? match = null;
            (ulong Device, UInt128 Inode, string? Path) identity = default;
            foreach (string candidate in originals[id].Distinct(StringComparer.Ordinal))
            {
                if (AvailablePath(candidate) is not { } path)
                    continue;
                try
                {
                    using var stream = OpenRead(path);
                    var rollout = RolloutPath.Resolve(path, stream);
                    var key = (rollout.Stat.Device, rollout.Stat.Inode, rollout.Stat.Inode == 0 ? rollout.Key : null);
                    if (match is not null && key != identity)
                        return default;
                    if (match is null || string.CompareOrdinal(Path.GetFileName(path), Path.GetFileName(match)) > 0)
                    {
                        match = path;
                        identity = key;
                    }
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    // A rollout can move into the archive between enumeration and opening.
                }
            }
            return match is null ? default : ReadOwnedHeader(match, id);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException
            or ArgumentException or InvalidOperationException or JsonException or NotSupportedException)
        {
            return default;
        }
    }

    private JsonElement ReadIndexedHeader(string path, string id)
    {
        try
        {
            if (!Path.IsPathFullyQualified(path) || OriginalId(path) != id || !directories.Any(directory => Under(path, directory))
                || AvailablePath(PlainPath(path)) is not { } available)
                return default;
            return ReadOwnedHeader(available, id);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException
            or ArgumentException or InvalidOperationException or JsonException or NotSupportedException)
        {
            return default;
        }
    }

    private ILookup<string, string> FindOriginalPaths()
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = 0,
        };
        return directories.Where(Directory.Exists)
            .SelectMany(directory => Directory.EnumerateFiles(directory, "rollout-*.jsonl*", options))
            .Select(path => (Path: PlainPath(path), Id: OriginalId(path)))
            .Where(candidate => candidate.Id is not null)
            .ToLookup(candidate => candidate.Id!, candidate => candidate.Path, StringComparer.Ordinal);
    }

    private static string? OriginalId(string path)
    {
        string name = Path.GetFileName(PlainPath(path));
        // Only the original basename carries the thread's own creation timestamp.
        const int uuidStart = 28; // "rollout-YYYY-MM-DDTHH-MM-SS-"
        return name.Length == uuidStart + 36 + ".jsonl".Length
            && name.StartsWith("rollout-", StringComparison.Ordinal) && name[uuidStart - 1] == '-'
            && name.EndsWith(".jsonl", StringComparison.Ordinal)
            && Guid.TryParseExact(name.AsSpan(uuidStart, 36), "D", out var owner) ? owner.ToString("D") : null;
    }

    private static bool Under(string path, string directory)
    {
        string relative = Path.GetRelativePath(directory, path);
        return !Path.IsPathRooted(relative) && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    private static string PlainPath(string path) => path.EndsWith(".zst", StringComparison.Ordinal) ? path[..^4] : path;

    private static string? AvailablePath(string plain) =>
        File.Exists(plain) ? plain : File.Exists(plain + ".zst") ? plain + ".zst" : null;

    private static FileStream OpenRead(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

    private static JsonElement ReadOwnedHeader(string path, string id)
    {
        var header = SessionFiles.ReadHeader(path);
        return SessionFiles.String(header, "id") == id ? header : default;
    }
}
