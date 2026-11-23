using System.Buffers;
using System.Text;
using System.Text.Json;

namespace ThreadMemoryHook;

internal sealed class RolloutHeader(byte[] bytes, int length, JsonDocument document) : IDisposable
{
    private const int ReadBytes = 4096;
    private const int MaximumBytes = 4 * 1024 * 1024;

    public int Length { get; } = length;
    public JsonElement Payload => document.RootElement.GetProperty("payload"u8);

    public string Segment(string name) => Convert.ToHexStringLower(Blake2s.Hash(
        Encoding.UTF8.GetBytes(name + '\0'), bytes.AsSpan(0, Length), 12));

    public void Dispose()
    {
        document.Dispose();
        ArrayPool<byte>.Shared.Return(bytes);
    }

    public static RolloutHeader? Read(Stream source, bool requireTerminator = false)
    {
        byte[]? buffer = ArrayPool<byte>.Shared.Rent(ReadBytes);
        try
        {
            var count = 0;
            while (count <= MaximumBytes)
            {
                if (count == buffer.Length)
                {
                    var grown = ArrayPool<byte>.Shared.Rent(Math.Min(buffer.Length * 2, MaximumBytes + 1));
                    buffer.AsSpan(0, count).CopyTo(grown);
                    ArrayPool<byte>.Shared.Return(buffer);
                    buffer = grown;
                }
                var read = source.Read(buffer.AsSpan(count, Math.Min(buffer.Length - count, MaximumBytes + 1 - count)));
                var newline = buffer.AsSpan(count, read).IndexOf((byte)'\n');
                if (newline >= 0 || read == 0)
                {
                    if (newline < 0 && requireTerminator)
                        return null;
                    var length = count + (newline < 0 ? 0 : newline + 1);
                    var row = Parse(buffer.AsMemory(0, length));
                    if (row is null)
                        return null;
                    var header = new RolloutHeader(buffer, length, row);
                    buffer = null; // The document retains the pooled bytes until disposed.
                    return header;
                }
                count += read;
            }
            return null;
        }
        finally
        {
            if (buffer is not null)
                ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static JsonDocument? Parse(ReadOnlyMemory<byte> raw)
    {
        if (raw.Span.StartsWith("\uFEFF"u8))
            raw = raw[3..];
        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 128 });
            var envelope = document.RootElement;
            var type = Property(envelope, "type"u8);
            var payload = Property(envelope, "payload"u8);
            if (type.ValueKind != JsonValueKind.String || !type.ValueEquals("session_meta"u8) ||
                payload.ValueKind != JsonValueKind.Object ||
                Property(envelope, "timestamp"u8).ValueKind is not (JsonValueKind.Undefined or JsonValueKind.String) ||
                Property(envelope, "metadata"u8).ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.Object) ||
                !OptionalString(payload, "id"u8) || !OptionalString(payload, "session_id"u8) || !OptionalString(payload, "forked_from_id"u8))
                return null;
            var result = document;
            document = null;
            return result;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { return null; }
        finally { document?.Dispose(); }
    }

    private static JsonElement Property(JsonElement element, ReadOnlySpan<byte> name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;

    private static bool OptionalString(JsonElement element, ReadOnlySpan<byte> name)
    {
        var value = Property(element, name);
        return value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ||
            value.ValueKind == JsonValueKind.String && value.GetString() is not null;
    }
}
