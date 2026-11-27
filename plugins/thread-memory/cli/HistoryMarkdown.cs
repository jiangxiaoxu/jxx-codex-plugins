using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace ThreadMemoryCli;

internal static class HistoryMarkdown
{
    internal static string FormatSearch(JsonObject result)
    {
        StringBuilder text = new("# Codex rollout search");
        var hits = result["items"]!.AsArray();
        if (hits.Count == 0)
            text.Append("\n\nNo matches.");
        int match = 0;
        foreach (var hit in hits.OfType<JsonObject>())
        {
            text.Append(CultureInfo.InvariantCulture, $"\n\n## Match {++match}");
            AppendLocation(text, hit);
            AppendExcerpt(text, hit["text"]!.GetValue<string>(), hit["text_truncated"]!.GetValue<bool>());
        }
        var context = result["context"]!.AsArray();
        if (context.Count > 0 || result["context_truncated"]!.GetValue<bool>())
        {
            text.Append("\n\n## Context");
            int record = 0;
            foreach (var entry in context.OfType<JsonObject>())
            {
                text.Append(CultureInfo.InvariantCulture, $"\n\n### Record {++record}");
                AppendLocation(text, entry);
                var fields = entry["fields"]!.AsArray().OfType<JsonObject>();
                AppendExcerpt(text, string.Join('\n', fields.Select(field => field["text"]!.GetValue<string>())),
                    entry["text_truncated"]!.GetValue<bool>());
            }
            if (result["context_truncated"]!.GetValue<bool>())
                text.Append("\n\n[Context was limited by the text budget.]");
        }
        AppendFooter(text, result, literalDamagePaths: true);
        return text.Append('\n').ToString();
    }

    internal static void AppendFooter(StringBuilder text, JsonObject result, bool literalDamagePaths = false)
    {
        if (result["next_cursor"] is JsonNode cursor)
            text.Append(CultureInfo.InvariantCulture, $"\n\nNext cursor: {cursor}");
        if (result["missing_base_rollouts"] is JsonArray gaps)
            text.Append("\n\nMissing rollout segments: ").AppendJoin(", ", gaps);
        if (result["damaged_records"] is JsonObject damaged && damaged["items"] is JsonArray issues)
        {
            text.Append(CultureInfo.InvariantCulture, $"\n\nDamaged records observed: {damaged["count"]}\n");
            foreach (var issue in issues.OfType<JsonObject>())
            {
                string location = $"{issue["path"]}:{issue["line"]}";
                text.Append("\n- ");
                if (literalDamagePaths)
                    AppendCodeSpan(text, location);
                else
                    text.Append(location);
                text.Append(CultureInfo.InvariantCulture, $", byte {issue["byte_offset"]} ({issue["reason"]})");
            }
        }
    }

    private static void AppendLocation(StringBuilder text, JsonObject entry)
    {
        text.Append("\n\nSource: ");
        AppendCodeSpan(text, $"{entry["path"]}:{entry["line"]}");
        text.Append("\n\nRef: ");
        AppendCodeSpan(text, entry["ref"]!.GetValue<string>());
    }

    private static void AppendCodeSpan(StringBuilder text, string value)
    {
        int ticks = DelimiterLength(value, 1);
        bool pad = value.StartsWith('`') || value.EndsWith('`');
        text.Append('`', ticks);
        if (pad)
            text.Append(' ');
        AppendVisible(text, value, multiline: false);
        if (pad)
            text.Append(' ');
        text.Append('`', ticks);
    }

    private static void AppendExcerpt(StringBuilder text, string value, bool truncated)
    {
        if (value.Length == 0)
            text.Append("\n\nNo readable text.");
        else
        {
            value = value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
            int ticks = DelimiterLength(value, 3);
            text.Append("\n\n").Append('`', ticks).Append('\n');
            AppendVisible(text, value, multiline: true);
            if (!value.EndsWith('\n'))
                text.Append('\n');
            text.Append('`', ticks);
        }
        if (truncated)
            text.Append("\n\n[Excerpt truncated.]");
    }

    private static void AppendVisible(StringBuilder text, string value, bool multiline)
    {
        foreach (char ch in value)
        {
            if (char.IsControl(ch) && !(multiline && ch is '\n' or '\t'))
                text.Append(CultureInfo.InvariantCulture, $"\\u{(int)ch:x4}");
            else
                text.Append(ch);
        }
    }

    private static int DelimiterLength(string value, int minimum)
    {
        int length = minimum, run = 0;
        foreach (char ch in value)
        {
            run = ch == '`' ? run + 1 : 0;
            length = Math.Max(length, run + 1);
        }
        return length;
    }
}
