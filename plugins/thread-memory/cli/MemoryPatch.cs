using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace ThreadMemoryHook;

internal static partial class MemoryPatch
{
    private const string NoNewline = @"\ No newline at end of file";

    [GeneratedRegex(@"\A@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@(?: .*)?\z")]
    private static partial Regex HunkHeader();

    internal static string Apply(string summary, string patch)
    {
        var source = SplitSource(summary);
        string defaultEnding = source.Length > 1 ? source[0].Ending : "\n";
        patch = patch.Replace("\r\n", "\n", StringComparison.Ordinal);
        string[] lines = (patch.EndsWith('\n') ? patch[..^1] : patch).Split('\n');
        int index = 0;
        bool gitHeader = lines[0].StartsWith("diff --git ", StringComparison.Ordinal);
        if (gitHeader)
        {
            index++;
            if (index < lines.Length && lines[index].StartsWith("index ", StringComparison.Ordinal))
                index++;
        }
        if (gitHeader || lines[index].StartsWith("--- ", StringComparison.Ordinal))
        {
            if (index + 1 >= lines.Length || !lines[index].StartsWith("--- ", StringComparison.Ordinal)
                || !lines[index + 1].StartsWith("+++ ", StringComparison.Ordinal))
                throw new ArgumentException("expected unified diff file headers");
            index += 2;
        }
        if (index == lines.Length)
            throw new ArgumentException("expected a unified diff hunk");

        var result = new List<(string Content, string Ending)>();
        int sourceIndex = 0;
        int? resultEof = null;
        while (index < lines.Length)
        {
            var header = HunkHeader().Match(lines[index]);
            if (!header.Success)
                throw new ArgumentException($"expected a unified diff hunk at patch line {index + 1}");

            int oldNumber = Coordinate(header.Groups[1], index);
            int oldCount = Coordinate(header.Groups[2], index);
            int newNumber = Coordinate(header.Groups[3], index);
            int newCount = Coordinate(header.Groups[4], index);
            int oldStart = oldCount == 0 ? oldNumber : oldNumber - 1;
            int newStart = newCount == 0 ? newNumber : newNumber - 1;
            if (oldStart < sourceIndex || oldStart > source.Length || oldCount > source.Length - oldStart
                || (oldCount == 0 && newCount == 0))
                throw new ArgumentException($"invalid or overlapping source range at patch line {index + 1}");

            int oldEnd = oldStart + oldCount;
            result.AddRange(new ArraySegment<(string Content, string Ending)>(source, sourceIndex, oldStart - sourceIndex));
            if (newStart != result.Count)
                throw new ArgumentException($"incorrect output range at patch line {index + 1}");

            long newEnd = (long)newStart + newCount;
            sourceIndex = oldStart;
            index++;
            while (sourceIndex < oldEnd || result.Count < newEnd)
            {
                if (index >= lines.Length)
                    throw new ArgumentException($"expected a unified diff body at patch line {index + 1}");
                string body = lines[index];
                // Git can omit the context prefix for an empty line.
                char prefix = body.Length == 0 ? ' ' : body[0];
                if (prefix is not (' ' or '-' or '+'))
                    throw new ArgumentException($"expected a unified diff body at patch line {index + 1}");
                string content = body.Length == 0 ? "" : body[1..];
                if (prefix != '+')
                {
                    if (sourceIndex >= oldEnd)
                        throw new ArgumentException($"too many source lines at patch line {index + 1}");
                    if (source[sourceIndex].Content != content)
                        throw new ArgumentException($"patch does not match summary line {sourceIndex + 1}");
                    sourceIndex++;
                }
                if (prefix != '-')
                {
                    if (result.Count >= newEnd)
                        throw new ArgumentException($"too many output lines at patch line {index + 1}");
                    result.Add(prefix == ' ' ? source[sourceIndex - 1] : (content, defaultEnding));
                }
                index++;

                if (index < lines.Length && lines[index] == NoNewline)
                {
                    if (prefix != '+' && sourceIndex != source.Length)
                        throw new ArgumentException($"end-of-file marker before last source line at patch line {index + 1}");
                    if (prefix != '-')
                    {
                        if (resultEof is not null)
                            throw new ArgumentException($"repeated output end-of-file marker at patch line {index + 1}");
                        resultEof = result.Count;
                    }
                    index++;
                }
            }
        }

        result.AddRange(new ArraySegment<(string Content, string Ending)>(source, sourceIndex, source.Length - sourceIndex));
        if (resultEof is not null && resultEof != result.Count)
            throw new ArgumentException("end-of-file marker before last output line");

        var output = new StringBuilder();
        for (int line = 0; line < result.Count; line++)
        {
            var (content, ending) = result[line];
            output.Append(content);
            if (line < result.Count - 1)
                output.Append(ending.Length == 0 ? defaultEnding : ending);
        }
        return output.ToString().TrimEnd('\r', '\n');
    }

    private static int Coordinate(Group group, int index)
    {
        if (!group.Success)
            return 1;
        if (int.TryParse(group.ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture, out int value))
            return value;
        throw new ArgumentException($"unified diff range is too large at patch line {index + 1}");
    }

    private static (string Content, string Ending)[] SplitSource(string summary)
    {
        if (summary.Length == 0)
            return [];
        string[] lines = summary.Split('\n');
        var source = new (string Content, string Ending)[lines.Length];
        for (int index = 0; index < lines.Length - 1; index++)
        {
            string line = lines[index];
            source[index] = line.EndsWith('\r') ? (line[..^1], "\r\n") : (line, "\n");
        }
        source[^1] = (lines[^1], "");
        return source;
    }
}
