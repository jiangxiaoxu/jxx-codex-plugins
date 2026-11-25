using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ThreadMemoryCli;

internal sealed record HistorySegment(
    string Path, string Id, JsonElement Header, long? EndOffset = null, long? EndOrdinal = null);

internal sealed record HistoryRow(
    HistorySegment Segment, long Line, long Offset, JsonElement Value, string Digest, int Window,
    string? Turn, string? Cwd, string Origin, string? OwnerThreadId, long NextOffset = 0,
    bool Gap = false, bool Copied = false, bool OwnershipUnknown = false)
{
    internal JsonElement Payload => Value.Get("payload");
    internal string Type => Value.Text("type") ?? "";
    internal string? ItemType => Payload.Text("type");
    internal string? Timestamp => Value.Text("timestamp");
    internal string Path => Segment.Path;
    internal string Cursor => FormattableString.Invariant($"{Segment.Id}:{Line}");

    internal string Ref(string kind = "record", int? index = null, int? start = null, int? end = null) =>
        new HistoryRef(Segment.Id, Line, Offset, Digest, kind, index, start, end).ToString();
}

internal sealed record HistoryRef(
    string SegmentId, long Line, long Offset, string Digest, string Kind, int? Index,
    int? Start = null, int? End = null)
{
    public override string ToString()
    {
        string head = FormattableString.Invariant($"r1:{SegmentId}:{Line:x}:{Offset:x}:{Digest}:{Kind}");
        if (Index is null && Start is null)
            return head;
        string indexed = FormattableString.Invariant($"{head}:{Index ?? -1}");
        return Start is null ? indexed : FormattableString.Invariant($"{indexed}:{Start}:{End}");
    }

    internal static HistoryRef Parse(string token)
    {
        string[] parts = token.Split(':');
        if (parts.Length is < 6 or > 9 or 8 || parts[0] != "r1" ||
            parts[1].Length != 16 || parts[1].AsSpan().ContainsAnyExcept("0123456789abcdef") ||
            parts[4].Length != 24 || parts[4].AsSpan().ContainsAnyExcept("0123456789abcdef") || parts[5].Length == 0 ||
            !long.TryParse(parts[2], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out long line) ||
            !long.TryParse(parts[3], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out long offset) ||
            line < 1 || offset < 0)
            throw new CliInputException("Invalid record reference. Request a fresh reference.");

        int? index = null;
        if (parts.Length >= 7)
        {
            if (!int.TryParse(parts[6], CultureInfo.InvariantCulture, out int parsed) || parsed < -1)
                throw new CliInputException("Invalid record field reference.");
            index = parsed == -1 ? null : parsed;
        }
        if (parts.Length != 9)
            return new HistoryRef(parts[1], line, offset, parts[4], parts[5], index);
        if (!int.TryParse(parts[7], CultureInfo.InvariantCulture, out int start) ||
            !int.TryParse(parts[8], CultureInfo.InvariantCulture, out int end) || start < 0 || end < start)
            throw new CliInputException("Invalid record reference character range.");
        return new HistoryRef(parts[1], line, offset, parts[4], parts[5], index, start, end);
    }
}

internal static class HistoryJson
{
    internal static JsonElement Get(this JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;

    internal static string? Text(this JsonElement element, string name) => element.Get(name).StringValue();

    internal static string? StringValue(this JsonElement element) => HistoryWire.String(element);

    internal static IEnumerable<JsonElement> Items(this JsonElement element) =>
        element.ValueKind == JsonValueKind.Array ? element.EnumerateArray() : Enumerable.Empty<JsonElement>();

    internal static IEnumerable<JsonProperty> Properties(this JsonElement element) =>
        element.ValueKind == JsonValueKind.Object ? element.EnumerateObject() : Enumerable.Empty<JsonProperty>();

    internal static JsonNode? ToNode(this JsonElement element) =>
        element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? null : JsonNode.Parse(HistoryWire.RenderRaw(element));
}

internal sealed class CliInputException(string message, string code = "invalid_input") : Exception(message)
{
    internal string Code { get; } = code;
}

internal sealed class RolloutReadException(string message, string path, long line) : Exception(message)
{
    internal string Path { get; } = path;
    internal long Line { get; } = line;
}
