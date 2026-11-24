using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using ThreadMemoryHook;

namespace ThreadMemoryPanel;

internal sealed record PanelRollout(string Path, string Owner, string Segment);

internal static class PanelFiles
{
    internal static string ThreadId(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String && value.GetString() is { Length: 36 } text &&
            Guid.TryParseExact(text, "D", out var id))
            return id.ToString("D");
        throw new InvalidDataException("Expected a thread UUID.");
    }

    internal static IEnumerable<PanelRollout> LocalRollouts(string home)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = false,
            AttributesToSkip = 0,
        };
        foreach (string name in new[] { "sessions", "archived_sessions" })
        {
            string directory = Path.Combine(home, name);
            try
            {
                File.GetAttributes(directory);
            }
            catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
            {
                continue;
            }
            foreach (string path in Directory.EnumerateFiles(directory, "rollout-*.jsonl*", options))
            {
                string filename = Path.GetFileName(path);
                int suffixLength = filename.EndsWith(".jsonl.zst", StringComparison.Ordinal) ? 10 : 6;
                if (suffixLength == 6 && !filename.EndsWith(".jsonl", StringComparison.Ordinal))
                    continue;
                int stemLength = filename.Length - suffixLength;
                if (stemLength < 36 || !Guid.TryParseExact(filename.AsSpan(stemLength - 36, 36), "D", out var segment))
                    continue;
                const int ownerStart = 28; // "rollout-YYYY-MM-DDTHH-MM-SS-"
                var ownership = filename.AsSpan(ownerStart, stemLength - ownerStart);
                int separator = ownership.IndexOf('_');
                if (!Guid.TryParseExact(separator < 0 ? ownership : ownership[..separator], "D", out var owner))
                    throw new InvalidDataException("A local rollout has an invalid owning thread UUID.");
                yield return new(path, owner.ToString("D"), segment.ToString("D"));
            }
        }
    }

    internal static IEnumerable<string> SessionIndexThreads(string home)
    {
        FileStream stream;
        try
        {
            stream = new FileStream(Path.Combine(home, "session_index.jsonl"), FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            yield break; // Codex creates the optional index when it first saves a thread name.
        }
        using (stream)
        using (var reader = new StreamReader(stream, new UTF8Encoding(false, true)))
        {
            while (reader.ReadLine() is { } line)
            {
                using var record = JsonDocument.Parse(line);
                yield return ThreadId(SessionFiles.Property(record.RootElement, "id"));
            }
        }
    }

    internal static JsonElement ReadHeader(PanelRollout rollout)
    {
        var header = SessionFiles.ReadHeader(rollout.Path);
        if (ThreadId(SessionFiles.Property(header, "id")) != rollout.Owner)
            throw new InvalidDataException("A rollout header does not identify its owning thread.");
        return header;
    }

    internal static SqliteConnection OpenDatabase(string path, SqliteOpenMode mode, bool foreignKeys = false)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = mode,
            Pooling = false,
            DefaultTimeout = 1,
            ForeignKeys = foreignKeys ? true : null,
        }.ToString());
        try
        {
            connection.Open();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }
}
