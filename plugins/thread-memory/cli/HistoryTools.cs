using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ThreadMemoryCli;

internal static partial class HistoryTools
{
    private static readonly string[] CommandInput =
        ["command", "cwd", "interaction_input", "parsed_cmd", "script_path"];
    private static readonly string[] CommandOutput = ["stdout", "stderr", "aggregated_output"];
    private static readonly string[] AgentInput = ["prompt", "model", "reasoning_effort"];
    private static readonly string[] McpOutput = ["result", "error"];
    private static readonly string[] PatchOutput = ["stdout", "stderr"];
    private static readonly string[] DynamicOutput = ["content_items", "error"];
    private const int DefaultLines = 20;
    private const int DefaultBudget = 4000;
    private const string ResultPrefix = "\n</command>\n<result>\n";
    private const string ShellType = "user_shell_command";

    private readonly record struct ToolRecord(string Type, JsonElement Item, string[] Fields);

    internal static JsonObject? Describe(HistoryRow row)
    {
        var input = Select(row, output: false);
        var output = Select(row, output: true);
        if ((input ?? output) is not { } record)
            return null;

        var metadata = Metadata(record);
        if (input is { Fields.Length: > 0 })
            metadata["input_id"] = row.Ref("input").ToString();
        if (output is { Fields.Length: > 0 })
            metadata["output_id"] = row.Ref("output").ToString();
        return metadata;
    }

    private static JsonObject Metadata(ToolRecord record)
    {
        JsonElement item = record.Item;
        JsonElement invocation = item.Get("invocation");
        JsonElement tool = invocation.ValueKind == JsonValueKind.Object ? invocation : item;
        var metadata = new JsonObject();
        foreach (var (field, value) in new[]
        {
            ("call_id", item.Text("call_id")),
            ("item_id", item.Text("id")),
            ("tool_name", Name(tool) ?? KnownName(record.Type)),
            ("tool_server", tool.Text("server")),
            ("tool_namespace", tool.Text("namespace")),
            ("tool_status", item.Text("status")),
        })
            if (value is not null && MetadataLabel().IsMatch(value))
                metadata[field] = value;
        if (item.Get("success") is { ValueKind: JsonValueKind.True or JsonValueKind.False } success)
            metadata["success"] = success.GetBoolean();
        if (item.Get("exit_code") is { ValueKind: JsonValueKind.Number } exitCode &&
            exitCode.TryGetInt64(out long code))
            metadata["exit_code"] = code;
        return metadata;
    }

    private static string? Name(JsonElement item) =>
        item.Text("tool") is { Length: > 0 } name ? name :
        item.Text("name") is { Length: > 0 } itemName ? itemName : null;

    private static string? KnownName(string type) => type switch
    {
        "tool_search_call" or "tool_search_output" => "tool_search",
        "CommandExecution" or "exec_command_begin" or "exec_command_end" or
            "local_shell_call" or ShellType => "exec_command",
        "ImageView" or "view_image_tool_call" => "view_image",
        "FileChange" or "patch_apply_begin" or "patch_apply_updated" or "patch_apply_end" => "apply_patch",
        "WebSearch" or "web_search_call" or "web_search_begin" or "web_search_end" or "web.search" => "web_search",
        "ImageGeneration" or "image_generation_call" or "image_generation_begin" or
            "image_generation_end" or "image_gen.generation" => "image_gen",
        "collab_agent_spawn_begin" or "collab_agent_spawn_end" => "spawn_agent",
        _ => null,
    };

    [GeneratedRegex(@"\A[a-zA-Z0-9_.:/+@-]{1,256}\z", RegexOptions.CultureInvariant)]
    private static partial Regex MetadataLabel();

    private static ToolRecord? Select(HistoryRow row, bool output)
    {
        var item = row.Payload;
        if (row.Type is not ("response_item" or "event_msg") ||
            item.Text("type") is not { } type)
            return null;
        bool eventRecord = row.Type == "event_msg";
        bool nestedItem = eventRecord && (type == "item_completed" || !output && type == "item_started");
        if (nestedItem)
        {
            item = item.Get("item");
            if (item.Text("type") is not { } nestedType)
                return null;
            type = nestedType == "Extension" ? item.Text("kind") ?? nestedType : nestedType;
        }
        if (type is "message" or "Message")
        {
            if (item.Text("role") == "user" &&
                RecordProjection.UserShellParts(item).Any(part => output || RecordProjection.ShellBoundary(part.Text) is not null))
                return new(ShellType, item, ["content"]);
            if (item.Text("role") is not ("tool" or "function"))
                return null;
        }
        string[]? fields = eventRecord
            ? (nestedItem ? NestedFields(type, output) : EventFields(type, output))
            : ResponseFields(type, output);
        if (fields is null)
            return null;
        if (fields.Any(field => FieldValue(item, field).ValueKind != JsonValueKind.Undefined))
            return new(type, item, fields);
        return output ? null : new(type, item, []);
    }

    private static string[]? ResponseFields(string type, bool output) => (type, output) switch
    {
        ("function_call" or "tool_search_call", false) => ["arguments"],
        ("custom_tool_call", false) => ["input"],
        ("local_shell_call" or "web_search_call", false) => ["action"],
        ("image_generation_call", false) => [],
        ("function_call_output" or "custom_tool_call_output" or "FunctionCallOutput", true) => ["output"],
        ("tool_search_output", true) => ["tools"],
        ("image_generation_call", true) => ["revised_prompt"],
        ("message" or "Message", true) => ["content"],
        _ => null,
    };

    private static string[]? EventFields(string type, bool output) => (type, output) switch
    {
        ("exec_command_begin" or "exec_command_end", false) => CommandInput,
        ("view_image_tool_call", false) => ["path"],
        ("patch_apply_begin" or "patch_apply_updated" or "patch_apply_end", false) => ["changes"],
        ("mcp_tool_call_begin" or "mcp_tool_call_end", false) => ["invocation.arguments", "arguments"],
        ("dynamic_tool_call_request" or "dynamic_tool_call_response", false) => ["arguments"],
        ("web_search_begin" or "image_generation_begin", false) => [],
        ("web_search_end", false) => ["query", "action"],
        ("image_generation_end", false) => ["input_images", "transparent_background"],
        ("collab_agent_spawn_begin" or "collab_agent_spawn_end", false) => AgentInput,
        ("collab_agent_interaction_begin" or "collab_agent_interaction_end", false) => ["receiver_thread_id", "prompt"],
        ("exec_command_end", true) => CommandOutput,
        ("patch_apply_end", true) => PatchOutput,
        ("mcp_tool_call_end", true) => McpOutput,
        ("dynamic_tool_call_response", true) => DynamicOutput,
        ("web_search_end", true) => ["results"],
        ("image_generation_end", true) => ["revised_prompt"],
        _ => null,
    };

    private static string[]? NestedFields(string type, bool output) => (type, output) switch
    {
        ("CommandExecution", false) => CommandInput,
        ("ImageView", false) => ["path"],
        ("FileChange", false) => ["changes"],
        ("McpToolCall" or "DynamicToolCall", false) => ["arguments"],
        ("WebSearch" or "web.search", false) => ["query", "action"],
        ("CollabAgentToolCall", false) => ["prompt", "model", "reasoning_effort", "receiver_thread_ids"],
        ("ImageGeneration", false) => [],
        ("image_gen.generation", false) => ["inputImages", "transparentBackground"],
        ("CommandExecution", true) => CommandOutput,
        ("FileChange", true) => PatchOutput,
        ("McpToolCall", true) => McpOutput,
        ("DynamicToolCall", true) => DynamicOutput,
        ("WebSearch" or "web.search", true) => ["results"],
        ("FunctionCallOutput", true) => ["output"],
        ("CollabAgentToolCall", true) => ["agents_states"],
        ("ImageGeneration", true) => ["revised_prompt"],
        ("image_gen.generation", true) => ["revisedPrompt"],
        ("message" or "Message", true) => ["content"],
        _ => null,
    };

    private static JsonElement FieldValue(JsonElement item, string field) =>
        field == "invocation.arguments" ? item.Get("invocation").Get("arguments") : item.Get(field);

    internal static JsonObject Run(CliOptions args, HistorySource source)
    {
        string direction = args.Command["tool-".Length..];
        bool output = direction == "output";
        ToolPageCursor? cursor = args.One("--cursor") is { } token
            ? ToolPageCursor.Parse(token, args.Command) : null;
        string? pointer = args.One("--pointer");
        if (cursor is not null && (args.Has("--id") || args.Has("--lines") ||
            args.Has("--budget-chars") || pointer is not null))
            throw new CliInputException("--cursor already contains the tool ID, line selection, and budget");
        if (pointer is not null && args.Has("--lines"))
            throw new CliInputException("--pointer and --lines are mutually exclusive");

        string id = cursor?.Id ?? args.Require("--id");
        HistoryRef target;
        try
        {
            target = HistoryRef.Parse(id);
        }
        catch (CliInputException)
        {
            throw new CliInputException($"expected a tool {direction} ID from rollout search or read");
        }
        if (target.Kind != direction || target.Index is not null || target.Start is not null)
            throw new CliInputException($"expected a tool {direction} ID from rollout search or read");
        if (!source.Segments.Any(segment => segment.Id == target.SegmentId))
            throw new CliInputException($"tool {direction} ID is outside the selected rollout lineage");
        HistoryRow? row = source.Find(target);
        if (row is null || Select(row, output) is not { Fields.Length: > 0 } record)
            throw new CliInputException(cursor is null
                ? $"tool {direction} ID is stale or outside the selected rollout scope"
                : $"tool {direction} cursor is stale: rollout record changed");

        JsonObject result = RecordProjection.Location(row);
        result["kind"] = row.Type;
        result["item_type"] = record.Type;
        result["role"] = "tool";
        result[$"{direction}_id"] = id;
        foreach (var (key, value) in Metadata(record))
            result[key] = value?.DeepClone();

        long budget = cursor?.Budget ?? args.Integer("--budget-chars", DefaultBudget, minimum: 1);
        if (pointer is not null)
        {
            result["pointer"] = pointer;
            result["value"] = PointerValue(record, output, pointer, budget);
            return result;
        }

        var selection = cursor?.Selection ?? ToolLineSelection.Parse(args.One("--lines"));
        var (fields, next) = Page(TextFields(record, output), selection, budget, cursor);
        if (cursor is not null && fields.Count == 0)
            throw new CliInputException("cursor is outside the requested tool record scope");
        result["items"] = fields;
        result["truncated"] = next is not null;
        result["next_cursor"] = next is { } position
            ? new ToolPageCursor(id, selection, budget, position.Index, position.Offset).Encode() : null;
        return result;
    }

    private readonly record struct ToolLineSelection(long First, long Last)
    {
        internal bool IsRange => Last > 0;

        internal static ToolLineSelection Parse(string? value)
        {
            if (value is null)
                return new(DefaultLines, 0);
            int split = value.IndexOf(':');
            if (split < 0 && TryPositive(value, out long count))
                return new(count, 0);
            if (split >= 0 && TryPositive(value.AsSpan(0, split), out long first) &&
                TryPositive(value.AsSpan(split + 1), out long last) && last >= first)
                return new(first, last);
            throw new CliInputException("--lines expects a positive line count or an inclusive START:END range");
        }
    }

    private sealed record ToolPageCursor(string Id, ToolLineSelection Selection, long Budget, int Field, int Offset)
    {
        internal static ToolPageCursor Parse(string token, string command)
        {
            if (token.StartsWith("t.", StringComparison.Ordinal) && token.Length <= 512)
            {
                Span<long> limits = stackalloc long[5];
                ReadOnlySpan<char> remainder = token.AsSpan(2);
                for (int index = limits.Length - 1; index >= 0; index--)
                {
                    int dot = remainder.LastIndexOf('.');
                    if (dot <= 0 || !long.TryParse(remainder[(dot + 1)..], NumberStyles.None,
                        CultureInfo.InvariantCulture, out limits[index]))
                        throw Invalid();
                    remainder = remainder[..dot];
                }
                if (limits[0] > 0 && (limits[1] == 0 || limits[1] >= limits[0]) &&
                    limits[2] is > 0 and <= int.MaxValue &&
                    limits[3] <= int.MaxValue && limits[4] <= int.MaxValue)
                {
                    var cursor = new ToolPageCursor(remainder.ToString().Replace('.', ':'),
                        new(limits[0], limits[1]), limits[2],
                        (int)limits[3], (int)limits[4]);
                    if (cursor.Encode() == token)
                        return cursor;
                }
            }
            throw Invalid();

            CliInputException Invalid() => new($"expected next_cursor from {command}");
        }

        internal string Encode() => FormattableString.Invariant(
            $"t.{Id.Replace(':', '.')}.{Selection.First}.{Selection.Last}.{Budget}.{Field}.{Offset}");
    }

    private static bool TryPositive(ReadOnlySpan<char> value, out long parsed) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed) && parsed > 0;

    private readonly record struct PagePosition(int Index, int Offset);

    private static (JsonArray Fields, PagePosition? Next) Page(
        IEnumerable<(string Field, string Body)> fields, ToolLineSelection selection,
        long remainingChars, ToolPageCursor? cursor)
    {
        long remainingLines = selection.IsRange ? selection.Last - selection.First + 1 : selection.First;
        long skip = selection.IsRange ? selection.First - 1 : 0;
        int index = -1;
        var page = new JsonArray();
        foreach (var (field, text) in fields)
        {
            index++;
            int start = 0;
            while (skip > 0 && start < text.Length)
            {
                int newline = text.IndexOf('\n', start);
                start = newline < 0 ? text.Length : newline + 1;
                skip--;
            }
            if (start == text.Length)
                continue;
            if (cursor is not null && index < cursor.Field)
            {
                if (selection.IsRange)
                {
                    remainingLines -= text.AsSpan(start).Count('\n') + (text[^1] == '\n' ? 0 : 1);
                    if (remainingLines <= 0)
                        break;
                }
                continue;
            }
            if (cursor is not null && page.Count == 0)
            {
                int offset = AdvanceCharacters(text, 0, cursor.Offset);
                if (index != cursor.Field || offset < start || offset == text.Length)
                    break;
                if (selection.IsRange)
                {
                    remainingLines -= text.AsSpan(start, offset - start).Count('\n');
                    if (remainingLines <= 0)
                        break;
                }
                start = offset;
            }
            int bound = AdvanceCharacters(text, start, remainingChars);
            int end = start;
            while (remainingLines > 0 && end < bound)
            {
                int newline = text.IndexOf('\n', end, bound - end);
                if (newline >= 0)
                    end = newline + 1;
                else if (bound == text.Length)
                    end = bound;
                else
                {
                    if (page.Count == 0 && end == start)
                        end = bound;
                    break;
                }
                remainingLines--;
            }
            if (end > start)
            {
                int textOffset = Characters(text.AsSpan(0, start));
                page.Add((JsonNode)new JsonObject
                {
                    ["field"] = field[..AdvanceCharacters(field, 0, 256)],
                    ["field_index"] = index,
                    ["text"] = text[start..end],
                    ["text_offset"] = textOffset,
                    ["text_total_chars"] = Characters(text.AsSpan()),
                });
                remainingChars -= Characters(text.AsSpan(start, end - start));
            }
            if (selection.IsRange && remainingLines == 0)
                break;
            if (end < text.Length)
                return (page, new(index, Characters(text.AsSpan(0, end))));
        }
        return (page, null);
    }

    private static int AdvanceCharacters(string text, int offset, long count)
    {
        if (count >= text.Length - offset)
            return text.Length;
        int end = offset + (int)count;
        while (offset < end && end < text.Length)
        {
            int high = text.AsSpan(offset, end - offset).IndexOfAnyInRange('\ud800', '\udbff');
            if (high < 0)
                break;
            offset += high;
            int width = char.IsSurrogatePair(text, offset) ? 2 : 1;
            end += width - 1;
            offset += width;
        }
        return end;
    }

    private static int Characters(ReadOnlySpan<char> text)
    {
        int characters = text.Length;
        while (text.IndexOfAnyInRange('\ud800', '\udbff') is int high && high >= 0)
        {
            int width = high + 1 < text.Length && char.IsLowSurrogate(text[high + 1]) ? 2 : 1;
            characters -= width - 1;
            text = text[(high + width)..];
        }
        return characters;
    }

    internal sealed class NameResolver
    {
        private readonly Dictionary<(string Family, string Call), (string Name, string? Namespace)?> calls = [];
        private (string Segment, bool Copied, string Origin, string? Turn)? scope;

        internal string? Observe(HistoryRow row)
        {
            if (row.Gap || row.Type == "compacted" ||
                row.Type == "event_msg" && row.ItemType is ("task_started" or "turn_started" or
                    "task_complete" or "turn_complete" or "turn_aborted" or "thread_rolled_back"))
                calls.Clear();
            if (row.Type != "response_item")
                return null;

            string? family = row.ItemType switch
            {
                "function_call" or "local_shell_call" or "function_call_output" => "function_call",
                "custom_tool_call" or "custom_tool_call_output" => "custom_tool_call",
                _ => null,
            };
            if (family is null)
                return null;
            var next = (row.Segment.Id, row.Copied, row.Origin, row.Turn);
            if (scope != next)
                calls.Clear();
            scope = next;
            if (row.OwnershipUnknown)
            {
                calls.Clear();
                return null;
            }
            if (row.Payload.Text("call_id") is not { } call || !MetadataLabel().IsMatch(call))
                return null;
            var key = (family, call);
            JsonElement payload = row.Payload;
            string? toolName = Name(payload);
            string? space = payload.Text("namespace");
            if (row.ItemType is "function_call" or "local_shell_call" or "custom_tool_call")
            {
                toolName ??= KnownName(row.ItemType);
                calls[key] = !calls.ContainsKey(key) && toolName is not null &&
                    MetadataLabel().IsMatch(toolName) &&
                    payload.Get("namespace").ValueKind is JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.String
                    ? (toolName, space) : null;
            }
            else if (toolName is null && calls.TryGetValue(key, out var prior) && prior is { } candidate &&
                (payload.Get("namespace").ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ||
                    space is not null && space == candidate.Namespace))
                return candidate.Name;
            return null;
        }
    }
}
