using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ThreadMemoryCli;

internal static class HistoryRecords
{
    private const int DefaultPreviewChars = 400;
    internal const int DefaultReferenceChars = 1000;
    private const int DefaultBudgetChars = 4000;
    private const int MaxContext = 20;

    internal static JsonObject Run(CliOptions args, HistorySource source)
    {
        int limit = args.Integer("--limit", 20);
        if (args.Command == "inventory")
            return Inventory(args, source, limit);

        int budget = args.Integer("--budget-chars", DefaultBudgetChars);
        string? reference = args.One("--ref");
        int maxChars = Math.Min(args.Integer("--max-chars", reference is null ? DefaultPreviewChars : DefaultReferenceChars), budget);
        if (reference is not null)
            return ReadReference(source, HistoryRef.Parse(reference), maxChars, CharacterRange(args));

        var cursor = args.One("--cursor");
        var tool = args.One("--tool");
        string? inferred = null;
        var resolver = tool is null ? null : new HistoryTools.NameResolver();
        Action<HistoryRow>? observe = resolver is null ? null : row => inferred = resolver.Observe(row);
        var rows = source.Rows(observe: observe);
        var kinds = new HashSet<string>(args.Many("--type"), StringComparer.Ordinal);
        var roles = new HashSet<string>(args.Many("--role"), StringComparer.Ordinal);
        bool Match(HistoryRow row, RecordProjection.View view) => (kinds.Count == 0 || kinds.Contains(view.Kind)
            || view.ItemType is { } item && kinds.Contains(item)
            || view.Kind == "event_msg" && row.ItemType is { } eventType && kinds.Contains(eventType))
            && (roles.Count == 0 || view.Role is { } role && roles.Contains(role))
            && (tool is null || tool == (view.Tool?["tool_name"]?.GetValue<string>() ?? inferred));

        if (args.Command == "read")
        {
            var field = args.One("--field");
            int? fieldIndex = args.Has("--field-index") ? args.Integer("--field-index", 0, minimum: 0) : null;
            var chars = CharacterRange(args);
            bool metadataOnly = args.Has("--metadata-only");
            bool includeEmpty = field is null && fieldIndex is null && chars is null && IsSingleLine(args.One("--lines"));
            var items = new JsonArray();
            string? last = null;
            foreach (var (row, _) in Resume(rows, cursor, 0))
            {
                var view = RecordProjection.Project(row);
                if (!Match(row, view))
                    continue;
                var all = RecordProjection.Readable(view.Fields);
                var selected = Select(all, field, fieldIndex);
                var preview = Preview(metadataOnly ? [] : selected, maxChars, chars);
                var details = RecordProjection.Details(row, view);
                if (preview.Fields.Count == 0 && (field is not null || fieldIndex is not null
                    || !(includeEmpty || metadataOnly || view.Encrypted is not null || view.Tool is not null
                        || view.ItemType is { } type && kinds.Contains(type) && details.Count > 0)))
                    continue;
                if (items.Count == limit || preview.Used > budget)
                    return Page(items, last);

                var entry = WithPreview(Locator(row, view, inferred, details), view, preview);
                if (metadataOnly)
                    entry["body_available"] = all.Any();
                entry["ref"] = SelectedReference(row, selected, field, fieldIndex, chars);
                items.Add((JsonNode)entry);
                last = row.Cursor;
                budget -= preview.Used;
            }
            return Page(items, null);
        }

        return Search(args, Resume(rows, cursor, args.Integer("--before", 0, minimum: 0, maximum: MaxContext)),
            Match, () => inferred, limit, maxChars, budget);
    }

    private static JsonObject Search(CliOptions args, IEnumerable<(HistoryRow Row, bool Eligible)> rows,
        Func<HistoryRow, RecordProjection.View, bool> matchesFilter, Func<string?> inferredName, int limit,
        int maxChars, int budget)
    {
        string pattern = args.Pattern!;
        bool ignoreCase = args.Has("--ignore-case");
        Regex? regex = null;
        if (args.Has("--regex"))
        {
            try
            {
                regex = new Regex(pattern, RegexOptions.Multiline | RegexOptions.CultureInvariant
                    | (ignoreCase ? RegexOptions.IgnoreCase : RegexOptions.None), TimeSpan.FromSeconds(1));
            }
            catch (ArgumentException error)
            {
                throw new CliInputException($"invalid regular expression: {error.Message}");
            }
        }
        var comparison = ignoreCase ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        int before = args.Integer("--before", 0, minimum: 0, maximum: MaxContext);
        int after = args.Integer("--after", 0, minimum: 0, maximum: MaxContext);
        var hits = new JsonArray();
        var context = new Dictionary<(string Segment, long Line), JsonObject>();
        var preceding = new Queue<(long Line, JsonObject Preview)>();
        string? last = null;
        string? priorSegment = null;
        long afterLine = 0;
        bool truncated = false;

        foreach (var (row, eligible) in rows)
        {
            if (row.Segment.Id != priorSegment)
            {
                preceding.Clear();
                afterLine = 0;
                priorSegment = row.Segment.Id;
            }
            if (truncated && row.Line > afterLine)
                break;
            var view = RecordProjection.Project(row);
            var fields = RecordProjection.Readable(view.Fields);
            if (eligible && !truncated && matchesFilter(row, view)
                && FindMatch(fields, pattern, comparison, regex) is { } match)
            {
                var (field, start, end) = match;
                int total = RecordProjection.CharacterCount(field.Text);
                int size = Math.Min(total, maxChars);
                if (hits.Count < limit && size <= budget)
                {
                    var hit = Locator(row, view, inferredName());
                    int offset = HitOffset(total, start, end, maxChars);
                    hit["field"] = field.Name;
                    hit["field_index"] = field.Index;
                    hit["text"] = RecordProjection.Slice(field.Text, offset, offset + size);
                    hit["text_offset"] = offset;
                    hit["text_total_chars"] = total;
                    hit["match_start"] = start;
                    hit["match_end"] = end;
                    hit["text_truncated"] = total > maxChars;
                    hit["ref"] = row.Ref("hit", field.Index, start, end);
                    hits.Add((JsonNode)hit);
                    last = row.Cursor;
                    budget -= size;
                    afterLine = row.Line + after;
                    foreach (var (line, previous) in preceding)
                        if (line >= row.Line - before)
                            context[(row.Segment.Id, line)] = previous;
                    continue;
                }
                truncated = true;
            }

            if (row.Line <= afterLine || before > 0 && !truncated)
            {
                var preview = Preview(fields, maxChars);
                if (preview.Fields.Count == 0 && view.Encrypted is null && view.Tool is null)
                    continue;
                var entry = WithPreview(Locator(row, view, inferredName()), view, preview);
                entry["ref"] = row.Ref();
                if (row.Line <= afterLine)
                    context[(row.Segment.Id, row.Line)] = entry;
                if (before > 0 && !truncated)
                {
                    if (preceding.Count == before)
                        preceding.Dequeue();
                    preceding.Enqueue((row.Line, entry));
                }
            }
        }

        var included = new JsonArray();
        bool contextTruncated = false;
        foreach (var entry in context.Values)
        {
            var fields = entry["fields"]!.AsArray();
            int size = fields.Sum(field => RecordProjection.CharacterCount(field!["text"]!.GetValue<string>()));
            if (size > budget)
            {
                contextTruncated = true;
                if (budget == 0)
                    continue;
                var clipped = Preview(fields.Select(field => (field!["field_index"]!.GetValue<int>(),
                    field["field"]!.GetValue<string>(), field["text"]!.GetValue<string>())), budget);
                entry["fields"] = clipped.Fields;
                entry["text_truncated"] = true;
            }
            included.Add((JsonNode)entry);
            budget -= Math.Min(size, budget);
        }

        var result = Page(hits, truncated ? last : null);
        result["context"] = included;
        result["context_truncated"] = contextTruncated;
        return result;
    }

    private static ((int Index, string Name, string Text) Field, int Start, int End)? FindMatch(
        IEnumerable<(int Index, string Name, string Text)> fields, string pattern, StringComparison comparison, Regex? regex)
    {
        try
        {
            foreach (var field in fields)
            {
                if (regex is null)
                {
                    int index = field.Text.IndexOf(pattern, comparison);
                    if (index >= 0)
                        return (field, RecordProjection.CharacterCount(field.Text, index),
                            RecordProjection.CharacterCount(field.Text, index + pattern.Length));
                }
                else
                {
                    var match = regex.Match(field.Text);
                    if (match.Success)
                        return (field, RecordProjection.CharacterCount(field.Text, match.Index),
                            RecordProjection.CharacterCount(field.Text, match.Index + match.Length));
                }
            }
        }
        catch (RegexMatchTimeoutException)
        {
            throw new CliInputException("regular expression took too long on one field. Use a narrower scope or a simpler pattern.");
        }
        return null;
    }

    private readonly record struct InventoryKey(string Kind, string ItemType, string EventType, string Extension, string Role)
    {
        internal string Cursor => "inv1:" + Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes(new JsonArray(Kind, ItemType, EventType, Extension, Role).ToJsonString())))[..24];
    }

    private static JsonObject Inventory(CliOptions args, HistorySource source, int limit)
    {
        var kinds = new HashSet<string>(args.Many("--type"), StringComparer.Ordinal);
        var roles = new HashSet<string>(args.Many("--role"), StringComparer.Ordinal);
        var groups = new Dictionary<InventoryKey, (long Count, JsonObject Example)>();
        long recordCount = 0;
        foreach (var row in source.Rows())
        {
            var view = RecordProjection.Project(row);
            string itemType = row.ItemType ?? "";
            string eventType = "";
            var payload = row.Payload;
            if (row.Type == "event_msg" && payload.Get("item").Text("type") is { Length: > 0 } nested)
            {
                (itemType, eventType) = (nested, itemType);
                payload = payload.Get("item");
            }
            string extension = itemType == "Extension" ? payload.Text("kind") ?? "" : "";
            string role = view.Role is "user" or "assistant" or "system" or "developer" or "tool" or "function" ? view.Role : "";
            if ((kinds.Count > 0 && !kinds.Contains(row.Type) && !kinds.Contains(itemType) && !kinds.Contains(eventType)
                && !kinds.Contains(extension) && (view.ItemType is null || !kinds.Contains(view.ItemType)))
                || roles.Count > 0 && !roles.Contains(role))
                continue;

            recordCount++;
            var key = new InventoryKey(row.Type, itemType, eventType, extension, role);
            if (groups.TryGetValue(key, out var group))
            {
                groups[key] = (group.Count + 1, group.Example);
                continue;
            }
            var example = RecordProjection.Location(row);
            example.Remove("turn_id");
            example["ref"] = row.Ref();
            example["read_type"] = view.ItemType;
            example["body_available"] = RecordProjection.Readable(view.Fields).Any();
            groups.Add(key, (1, example));
        }

        string? cursor = args.One("--cursor");
        if (cursor is not null && (!cursor.StartsWith("inv1:", StringComparison.Ordinal) || cursor.Length != 29
            || cursor.AsSpan(5).IndexOfAnyExcept("0123456789abcdef") >= 0))
            throw new CliInputException("invalid inventory cursor; use next_cursor from the previous page");
        bool waiting = cursor is not null;
        string? last = null;
        var items = new JsonArray();
        foreach (var key in groups.Keys.OrderBy(key => key.Kind, StringComparer.Ordinal)
            .ThenBy(key => key.ItemType, StringComparer.Ordinal).ThenBy(key => key.EventType, StringComparer.Ordinal)
            .ThenBy(key => key.Extension, StringComparer.Ordinal).ThenBy(key => key.Role, StringComparer.Ordinal))
        {
            if (waiting)
            {
                waiting = key.Cursor != cursor;
                continue;
            }
            if (items.Count == limit)
            {
                cursor = last;
                break;
            }
            cursor = null;
            last = key.Cursor;
            var (count, example) = groups[key];
            items.Add((JsonNode)new JsonObject
            {
                ["kind"] = key.Kind, ["item_type"] = OrNull(key.ItemType), ["event_type"] = OrNull(key.EventType),
                ["extension"] = OrNull(key.Extension), ["role"] = OrNull(key.Role), ["count"] = count, ["example"] = example,
            });
        }
        if (waiting)
            throw new CliInputException("inventory cursor is not within the selected rollout scope");
        var page = Page(items, items.Count == 0 ? null : cursor);
        page["group_count"] = groups.Count;
        page["record_count"] = recordCount;
        return page;
    }

    private static string? OrNull(string value) => value.Length == 0 ? null : value;

    private static JsonObject ReadReference(HistorySource source, HistoryRef reference, int maxChars, (int Start, int End)? chars)
    {
        if (reference.Kind is not ("record" or "field" or "hit" or "transcript"))
            throw new CliInputException("expected a reference from rollout search, read, or transcript");
        var row = source.Find(reference, includeToolBodies: false)
            ?? throw new CliInputException("reference is stale or outside the selected rollout lineage");
        JsonObject item;
        if (reference.Kind == "transcript")
        {
            var (message, _) = HistoryChat.VerifyReference(row, reference);
            var text = message["text"]!.GetValue<string>();
            message.Remove("text");
            var preview = Preview([(0, "text", text)], maxChars, chars, offsets: true);
            message["fields"] = preview.Fields;
            message["text_truncated"] = preview.Truncated;
            item = message;
        }
        else
        {
            var view = RecordProjection.Project(row);
            var fields = ProjectReference(row, reference, view);
            var locator = Locator(row, view);
            if (reference.Start is int start && reference.End is int end)
            {
                if (reference.Kind == "hit")
                {
                    locator["match_start"] = start;
                    locator["match_end"] = end;
                    if (chars is null)
                    {
                        int length = RecordProjection.CharacterCount(fields.First().Text);
                        chars = (HitOffset(length, start, end, maxChars), length);
                    }
                }
                else if (chars is null)
                    chars = (start, end);
            }
            item = WithPreview(locator, view, Preview(fields, maxChars, chars, offsets: true));
        }
        item["ref"] = reference.ToString();
        return new JsonObject { ["items"] = new JsonArray(item), ["next_cursor"] = null };
    }

    internal static void VerifyReference(HistoryRow row, HistoryRef reference)
    {
        if (reference.Kind == "transcript")
            _ = HistoryChat.VerifyReference(row, reference);
        else
            _ = ProjectReference(row, reference, RecordProjection.Project(row));
    }

    private static IEnumerable<(int Index, string Name, string Text)> ProjectReference(HistoryRow row, HistoryRef reference,
        RecordProjection.View view)
    {
        var fields = RecordProjection.Readable(view.Fields);
        if (reference.ToString() == row.Ref() && reference.Kind == "record")
            return fields;
        if (reference.Kind is "field" or "hit" && reference.Index is int index
            && reference.Start is int start && reference.End is int end
            && reference.ToString() == row.Ref(reference.Kind, index, start, end))
        {
            foreach (var field in fields)
                if (field.Index == index && end <= RecordProjection.CharacterCount(field.Text))
                    return [field];
        }
        throw new CliInputException("rollout reference is stale or no longer matches the selected view");
    }

    private static string SelectedReference(HistoryRow row, IEnumerable<(int Index, string Name, string Text)> fields,
        string? field, int? fieldIndex, (int Start, int End)? chars)
    {
        if (field is not null || fieldIndex is not null)
        {
            using var iterator = fields.GetEnumerator();
            if (iterator.MoveNext())
            {
                var entry = iterator.Current;
                if (fieldIndex is not null || !iterator.MoveNext())
                {
                    int length = RecordProjection.CharacterCount(entry.Text);
                    return row.Ref("field", entry.Index, Math.Min(chars?.Start ?? 0, length), Math.Min(chars?.End ?? length, length));
                }
            }
        }
        return row.Ref();
    }

    private static IEnumerable<(int Index, string Name, string Text)> Select(
        IEnumerable<(int Index, string Name, string Text)> fields, string? field, int? fieldIndex)
    {
        foreach (var entry in fields)
        {
            if (fieldIndex is int index && entry.Index > index)
                yield break;
            if ((field is null || entry.Name == field) && (fieldIndex is null || entry.Index == fieldIndex))
                yield return entry;
        }
    }

    private static JsonObject Locator(HistoryRow row, RecordProjection.View view, string? inferred = null, JsonObject? details = null)
    {
        var locator = RecordProjection.Location(row);
        locator["kind"] = view.Kind;
        locator["item_type"] = view.ItemType;
        locator["role"] = view.Role;
        if (view.Kind == "event_msg" && row.ItemType is { } eventType && eventType != view.ItemType)
            locator["event_type"] = eventType;
        if (inferred is not null)
            locator["tool_name"] = inferred;
        details ??= RecordProjection.Details(row, view);
        if (details.Count > 0)
            locator["details"] = details;
        if (view.Tool is not null)
            foreach (var property in view.Tool)
                locator[property.Key] = property.Value?.DeepClone();
        return locator;
    }

    private static JsonObject WithPreview(JsonObject locator, RecordProjection.View view, FieldPreview preview)
    {
        if (view.Encrypted is not null)
            locator["encrypted_tokens"] = view.Encrypted;
        locator["fields"] = preview.Fields;
        locator["text_truncated"] = preview.Truncated;
        return locator;
    }

    private readonly record struct FieldPreview(JsonArray Fields, int Used, bool Truncated);

    private static FieldPreview Preview(IEnumerable<(int Index, string Name, string Text)> fields, int maxChars,
        (int Start, int End)? chars = null, bool offsets = false)
    {
        var result = new JsonArray();
        int remaining = maxChars;
        foreach (var field in fields)
        {
            int length = RecordProjection.CharacterCount(field.Text);
            int start = Math.Min(chars?.Start ?? 0, length);
            int end = Math.Min(chars?.End ?? length, length);
            if (end <= start)
                continue;
            if (remaining == 0)
                return new FieldPreview(result, maxChars, true);
            int size = Math.Min(end - start, remaining);
            var entry = new JsonObject
            {
                ["field"] = field.Name, ["field_index"] = field.Index, ["text"] = RecordProjection.Slice(field.Text, start, start + size),
            };
            if (offsets || chars is not null)
            {
                entry["text_offset"] = start;
                entry["text_total_chars"] = length;
            }
            result.Add((JsonNode)entry);
            remaining -= size;
            if (end - start > size)
                return new FieldPreview(result, maxChars, true);
        }
        return new FieldPreview(result, maxChars - remaining, false);
    }

    private static int HitOffset(int length, int start, int end, int maxChars) =>
        Math.Max(0, Math.Min(start - Math.Max(0, maxChars - (end - start)) / 2, length - maxChars));

    private static IEnumerable<(HistoryRow Row, bool Eligible)> Resume(IEnumerable<HistoryRow> rows, string? cursor, int before)
    {
        if (cursor is null)
        {
            foreach (var row in rows)
                yield return (row, true);
            yield break;
        }
        var pieces = cursor.Split(':');
        if (pieces is not [var segment, var number] || segment.Length == 0
            || !long.TryParse(number, NumberStyles.None, CultureInfo.InvariantCulture, out long target) || target < 1)
            throw new CliInputException("invalid row cursor; use next_cursor from the previous page");

        bool found = false;
        long start = target - Math.Max(before - 1, 0);
        foreach (var row in rows)
        {
            if (found)
                yield return (row, true);
            else if (row.Segment.Id == segment && row.Line >= start && row.Line <= target)
            {
                if (before > 0)
                    yield return (row, false);
                found = row.Line == target;
            }
        }
        if (!found)
            throw new CliInputException("cursor is not within the selected rollout scope");
    }

    private static bool IsSingleLine(string? value)
    {
        if (value?.Split(':') is not [var start, var end])
            return false;
        return long.TryParse(start, CultureInfo.InvariantCulture, out long first)
            && long.TryParse(end, CultureInfo.InvariantCulture, out long last) && first == last;
    }

    private static (int Start, int End)? CharacterRange(CliOptions args)
    {
        if (args.One("--chars") is not { } value)
            return null;
        if (value.Split(':') is not [var first, var last] || !int.TryParse(first, CultureInfo.InvariantCulture, out int start)
            || !int.TryParse(last, CultureInfo.InvariantCulture, out int end) || start < 0 || end <= start)
            throw new CliInputException("--chars requires 0 <= START < END", "invalid_arguments");
        return (start, end);
    }

    private static JsonObject Page(JsonArray items, string? cursor) => new()
    {
        ["items"] = items, ["truncated"] = cursor is not null, ["next_cursor"] = cursor,
    };
}
