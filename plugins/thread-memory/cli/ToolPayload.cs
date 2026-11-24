using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace ThreadMemoryCli;

internal static partial class HistoryTools
{
    private static readonly string[] ResourceProperties = ["uri", "mimeType", "text"];
    private static readonly string[] LinkProperties = ["uri", "name", "title", "description", "mimeType", "size"];
    private static readonly HashSet<string> OpaqueKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "base64", "b64_json", "image_url", "imageurl", "audio_url", "audiourl", "raw_content",
        "_meta", "blob", "internal_chat_message_metadata_passthrough",
    };
    private static readonly object Missing = new();
    private const string HiddenDataUrl = "[data URL omitted]";

    private static bool Mcp(string type) => type is "mcp_tool_call_end" or "McpToolCall";
    private static bool TextPart(string? type) =>
        type is "input_text" or "inputText" or "output_text" or "text" or "Text" or "summary_text";
    private static bool PathPart(string? type) => type is "local_image" or "local_audio";
    private static bool ContentBlockField(string field) => field is "output" or "content_items" or "content";

    [GeneratedRegex(@"(?<![a-z0-9_+.-])data:[^\s""'<>;,]*(?:;[^\s""'<>;,]+)*,[^\s""'<>]*",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DataUrls();

    [GeneratedRegex(@"\A(?:file:|[a-z]:[/\\]|[/\\])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LocalReference();

    [GeneratedRegex(@"~(?![01])", RegexOptions.CultureInvariant)]
    private static partial Regex PointerEscape();

    private static bool ContainsUrl(string text) => text.Contains("data:", StringComparison.OrdinalIgnoreCase);
    private static string HideDataUrls(string text) =>
        ContainsUrl(text) ? DataUrls().Replace(text, HiddenDataUrl) : text;

    private static bool HiddenKey(string key) =>
        OpaqueKeys.Contains(key) ||
        key.StartsWith("_rollout_", StringComparison.OrdinalIgnoreCase) ||
        key.StartsWith("encrypted", StringComparison.OrdinalIgnoreCase) ||
        key.EndsWith("base64", StringComparison.OrdinalIgnoreCase) ||
        ContainsUrl(key) && DataUrls().IsMatch(key);

    private static bool HiddenType(string? type) => type is not null &&
        (type.ToLowerInvariant() is "image" or "audio" or "input_image" or "inputimage" or "input_audio" or "inputaudio" ||
            type.StartsWith("encrypted", StringComparison.OrdinalIgnoreCase));

    private static string? LocalImageReference(JsonElement block, string? type)
    {
        if (type is "image" or "input_image" or "inputImage")
        {
            string? reference = block.Text("image_url");
            if (string.IsNullOrEmpty(reference))
                reference = block.Text("imageUrl");
            if (string.IsNullOrEmpty(reference))
                reference = block.Text("url");
            if (reference is not null && LocalReference().IsMatch(reference))
                return reference;
        }
        return null;
    }

    private static JsonElement EmbeddedJson(JsonElement value, bool parseScalar = false)
    {
        if (value.StringValue() is not { } text)
            return value;
        var trimmed = text.AsSpan().TrimStart();
        if (!parseScalar && (trimmed.Length == 0 || trimmed[0] is not ('{' or '[')))
            return value;
        try
        {
            return JsonElement.Parse(text, new JsonDocumentOptions { MaxDepth = 1000 });
        }
        catch (JsonException)
        {
            return value;
        }
    }

    private static IEnumerable<(string Field, string Body)> TextFields(ToolRecord record, bool output)
    {
        foreach (var (field, body) in ExtractText(record, output))
        {
            string text = HideDataUrls(body);
            if (text.Length > 0)
                yield return (field, text);
        }
    }

    private static IEnumerable<(string Field, string Body)> ExtractText(ToolRecord record, bool output)
    {
        if (record.Type == ShellType)
        {
            foreach (var (index, text) in RecordProjection.UserShellParts(record.Item))
            {
                var boundary = RecordProjection.ShellBoundary(text);
                if (!output && boundary is not null)
                    yield return ($"content[{index}].command", text[RecordProjection.ShellPrefix.Length..boundary.Index]);
                else if (output && boundary is not null)
                    yield return ($"content[{index}].result", text[(boundary.Index + ResultPrefix.Length)..^RecordProjection.ShellSuffix.Length]);
                else if (output)
                    yield return ($"content[{index}].text", text);
            }
            yield break;
        }
        foreach (string field in record.Fields)
        {
            JsonElement value = FieldValue(record.Item, field);
            var values = !output
                ? Values(field.EndsWith("arguments", StringComparison.Ordinal) ? EmbeddedJson(value) : value, field)
                : OutputText(record.Type, field, value);
            foreach (var pair in values)
                yield return pair;
        }
    }

    private static IEnumerable<(string Field, string Body)> OutputText(string type, string field, JsonElement value)
    {
        if (Mcp(type))
        {
            if (field == "result")
                return McpText(value, field);
            return value.ValueKind == JsonValueKind.Object
                ? Values(value.Get("message"), "error.message").Concat(McpText(value.Get("result"), "error.result"))
                : Values(value, field);
        }
        if (ContentBlockField(field) && value.ValueKind == JsonValueKind.Array)
            return Parts(value, field);
        return Values(field is "output" or "content" ? EmbeddedJson(value) : value, field);
    }

    private static IEnumerable<(string Field, string Body)> McpText(JsonElement value, string field)
    {
        if (value.ValueKind != JsonValueKind.Object)
            return [];
        if (value.Get("Err") is { ValueKind: not JsonValueKind.Undefined } error)
            return Values(EmbeddedJson(error), field + ".error");
        if (value.Get("Ok") is { ValueKind: not JsonValueKind.Undefined } ok)
            value = ok;
        return Parts(value.Get("content"), field + ".content")
            .Concat(Values(value.Get("structuredContent"), field + ".structuredContent"));
    }

    private static IEnumerable<(string Field, string Body)> Parts(JsonElement value, string field)
    {
        int index = -1;
        foreach (JsonElement part in value.Items())
        {
            string path = $"{field}[{++index}]";
            string? type = part.Text("type");
            if (TextPart(type))
                foreach (var pair in Values(EmbeddedJson(part.Get("text")), path + ".text"))
                    yield return pair;
            else if (PathPart(type))
                foreach (var pair in Values(part.Get("path"), path + ".path"))
                    yield return pair;
            else if (LocalImageReference(part, type) is { } reference)
                yield return (path + ".image_url", reference);
            else if (type is "resource" or "resource_link")
            {
                bool resource = type == "resource";
                JsonElement owner = resource ? part.Get("resource") : part;
                string location = resource ? path + ".resource." : path + ".";
                foreach (string property in resource ? ResourceProperties : LinkProperties)
                    foreach (var pair in Values(owner.Get(property), location + property))
                        yield return pair;
            }
        }
    }

    private static IEnumerable<(string Field, string Body)> Values(JsonElement value, string field)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                if (value.StringValue() is { Length: > 0 } text)
                    yield return (field, text);
                break;
            case JsonValueKind.Number:
            case JsonValueKind.True:
            case JsonValueKind.False:
                yield return (field, value.GetRawText());
                break;
            case JsonValueKind.Array:
                int index = 0;
                foreach (var item in value.EnumerateArray())
                    foreach (var pair in Values(item, $"{field}[{index++}]"))
                        yield return pair;
                break;
            case JsonValueKind.Object:
                if (HiddenType(value.Text("type")))
                    break;
                foreach (var property in value.EnumerateObject())
                    if (!HiddenKey(property.Name))
                    {
                        string key = Characters(property.Name.AsSpan()) <= 80 ? property.Name : "[key]";
                        foreach (var pair in Values(property.Value, $"{field}.{key}"))
                            yield return pair;
                    }
                break;
        }
    }

    private readonly record struct ProjectedContent(JsonElement Blocks)
    {
        internal object At(int index)
        {
            JsonElement part = Blocks[index];
            string? type = part.Text("type");
            if (TextPart(type))
            {
                var fields = Present(part, ["type", "text"]);
                if (fields.TryGetValue("text", out object? text) && text is JsonElement value)
                    fields["text"] = EmbeddedJson(value);
                return fields;
            }
            if (PathPart(type))
                return Present(part, ["type", "path"]);
            if (LocalImageReference(part, type) is { } path)
                return new Dictionary<string, object?> { ["path"] = path };
            if (type == "resource" && part.Get("resource").ValueKind == JsonValueKind.Object)
                return new Dictionary<string, object?>
                {
                    ["type"] = part.Get("type"),
                    ["resource"] = Present(part.Get("resource"), ResourceProperties),
                };
            return type == "resource_link"
                ? Present(part, ["type", .. LinkProperties])
                : Missing;
        }
    }

    private static Dictionary<string, object?> Present(JsonElement value, string[] properties)
    {
        var fields = new Dictionary<string, object?>();
        foreach (string key in properties)
            if (value.Get(key) is { ValueKind: not JsonValueKind.Undefined } child)
                fields[key] = child;
        return fields;
    }

    private static object McpValue(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object)
            return value;
        if (value.Get("Err") is { ValueKind: not JsonValueKind.Undefined } error)
            return new Dictionary<string, object?> { ["error"] = error };
        if (value.Get("Ok") is { ValueKind: not JsonValueKind.Undefined } ok)
            value = ok;
        if (value.ValueKind != JsonValueKind.Object)
            return value;
        var result = Present(value, ["structuredContent", "content"]);
        if (value.Get("isError") is { ValueKind: JsonValueKind.True or JsonValueKind.False } isError)
            result["isError"] = isError;
        if (value.Get("content") is { ValueKind: JsonValueKind.Array } content)
            result["content"] = new ProjectedContent(content);
        return result;
    }

    private static object? PointerRoot(ToolRecord record, bool output)
    {
        var root = new Dictionary<string, object?>();
        foreach (string field in record.Fields)
        {
            JsonElement value = FieldValue(record.Item, field);
            string key = field == "invocation.arguments" ? "arguments" : field;
            if (value.ValueKind == JsonValueKind.Undefined || root.ContainsKey(key))
                continue;
            if (output && Mcp(record.Type))
            {
                if (field == "result")
                    root[key] = McpValue(value);
                else if (value.ValueKind == JsonValueKind.Object)
                {
                    var error = Present(value, ["message", "result"]);
                    if (error.ContainsKey("result"))
                        error["result"] = McpValue(value.Get("result"));
                    root[key] = error;
                }
                else
                    root[key] = value;
            }
            else if (output && ContentBlockField(field) && value.ValueKind == JsonValueKind.Array)
                root[key] = new ProjectedContent(value);
            else if (record.Type == "function_call" && key == "arguments")
                root[key] = EmbeddedJson(value, parseScalar: true);
            else if (output && field is "output" or "content")
                root[key] = EmbeddedJson(value);
            else
                root[key] = value;
        }
        return root;
    }

    private static JsonNode? PointerValue(ToolRecord record, bool output, string pointer, long budget)
    {
        if (record.Type == ShellType)
            throw new CliInputException("manual shell records have no structured value; use the line view");
        if (pointer.Length > 0 && (pointer[0] != '/' || PointerEscape().IsMatch(pointer)))
            throw new CliInputException("invalid JSON Pointer; start with / and escape ~ as ~0 and / as ~1");
        object? value = PointerRoot(record, output);
        if (pointer.Length > 0)
            foreach (string part in pointer[1..].Split('/'))
            {
                string key = part.Replace("~1", "/").Replace("~0", "~");
                value = SelectPointer(value, key);
                if (HiddenValue(value))
                    throw new CliInputException("JSON Pointer does not select a visible tool value");
            }
        return CleanValue(value, ref budget);
    }

    private static object? SelectPointer(object? value, string key)
    {
        if (value is Dictionary<string, object?> map)
            return !HiddenKey(key) && map.TryGetValue(key, out var child) ? child : Missing;
        if (value is JsonElement { ValueKind: JsonValueKind.Object } element)
            return !HiddenKey(key) ? element.Get(key) : Missing;
        if (key.AsSpan().IndexOfAnyExceptInRange('0', '9') >= 0 ||
            !int.TryParse(key, NumberStyles.None, CultureInfo.InvariantCulture, out int index) ||
            key.Length > 1 && key[0] == '0')
            return Missing;
        if (value is ProjectedContent content && index < content.Blocks.GetArrayLength())
            return content.At(index);
        if (value is JsonElement { ValueKind: JsonValueKind.Array } array && index < array.GetArrayLength())
            return array[index];
        return Missing;
    }

    private static bool HiddenValue(object? value) => value == Missing ||
        value is JsonElement element && (element.ValueKind == JsonValueKind.Undefined || HiddenType(element.Text("type")));

    private static JsonNode? CleanValue(object? value, ref long budget)
    {
        if (HiddenValue(value))
            value = null;
        if (value is Dictionary<string, object?> map)
            return CleanObject(map.Select(pair => (pair.Key, pair.Value)), ref budget);
        if (value is ProjectedContent content)
            return CleanArray(Enumerable.Range(0, content.Blocks.GetArrayLength()).Select(content.At), ref budget);
        if (value is JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.Object)
                return CleanObject(element.EnumerateObject().Select(pair => (pair.Name, (object?)pair.Value)), ref budget);
            if (element.ValueKind == JsonValueKind.Array)
                return CleanArray(element.EnumerateArray().Select(child => (object?)child), ref budget);
            if (element.ValueKind != JsonValueKind.String)
            {
                Spend(ref budget, element.GetRawText().Length);
                return element.ToNode();
            }
            value = element.StringValue();
        }
        if (value is string text)
        {
            text = HideDataUrls(text);
            SpendString(ref budget, text);
            return JsonValue.Create(text);
        }
        Spend(ref budget, 4);
        return null;
    }

    private static JsonObject CleanObject(IEnumerable<(string Key, object? Value)> entries, ref long budget)
    {
        Spend(ref budget, 2);
        var result = new JsonObject();
        foreach (var (key, child) in entries)
        {
            if (HiddenKey(key) || HiddenValue(child))
                continue;
            Spend(ref budget, result.Count == 0 ? 1 : 2);
            SpendString(ref budget, key);
            result[key] = CleanValue(child, ref budget);
        }
        return result;
    }

    private static JsonArray CleanArray(IEnumerable<object?> values, ref long budget)
    {
        Spend(ref budget, 2);
        var result = new JsonArray();
        foreach (object? child in values)
        {
            if (result.Count > 0)
                Spend(ref budget, 1);
            result.Add(CleanValue(child, ref budget));
        }
        return result;
    }

    private static void SpendString(ref long budget, string text)
    {
        Spend(ref budget, 2);
        foreach (var rune in text.EnumerateRunes())
        {
            int width = rune.Value switch
            {
                '"' or '\\' or '\r' or '\n' or '\t' or '\b' or '\f' => 2,
                < 0x20 => 6,
                _ => 1,
            };
            Spend(ref budget, width);
        }
    }

    private static void Spend(ref long budget, int amount)
    {
        budget -= amount;
        if (budget < 0)
            throw new CliInputException(
                "tool value exceeds --budget-chars; select a narrower JSON Pointer or increase --budget-chars");
    }
}
