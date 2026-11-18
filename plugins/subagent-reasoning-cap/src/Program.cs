using System.Text.Json;

try
{
    using var input = JsonDocument.Parse(Console.OpenStandardInput());
    var toolInput = Property(input.RootElement, "tool_input");
    var role = StringValue(Property(toolInput, "agent_type"))?.Trim();
    var existingEffort = Property(toolInput, "reasoning_effort");
    if (role is not ("explorer" or "worker") ||
        existingEffort.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
    {
        return;
    }

    var transcriptPath = StringValue(Property(input.RootElement, "transcript_path"));
    if (string.IsNullOrEmpty(transcriptPath))
    {
        return;
    }

    var appliedEffort = ReadLatestEffort(transcriptPath);
    var effort = appliedEffort switch
    {
        "xhigh" or "max" or "ultra" => "high",
        "none" or "minimal" or "low" or "medium" or "high" => appliedEffort,
        _ => null
    };
    if (effort is null)
    {
        return;
    }

    using var stdout = Console.OpenStandardOutput();
    using (var writer = new Utf8JsonWriter(stdout))
    {
        writer.WriteStartObject();
        writer.WriteStartObject("hookSpecificOutput");
        writer.WriteString("hookEventName", "PreToolUse");
        writer.WriteString("permissionDecision", "allow");
        writer.WriteStartObject("updatedInput");
        foreach (var argument in toolInput.EnumerateObject())
        {
            if (!argument.NameEquals("reasoning_effort"))
            {
                argument.WriteTo(writer);
            }
        }
        writer.WriteString("reasoning_effort", effort);
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.WriteEndObject();
    }
    stdout.WriteByte((byte)'\n');
}
catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException or ArgumentException)
{
    // Leave the original tool input in effect when the hook input or transcript cannot be read.
}

static string? ReadLatestEffort(string path)
{
    const int BlockSize = 64 * 1024;
    var marker = "\"thread_settings_applied\""u8;
    using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    var block = new byte[BlockSize + marker.Length - 1];
    var fileLength = file.Length;
    long offset = fileLength;
    long lineEnd = fileLength;
    var containsMarker = false;

    while (offset > 0)
    {
        var length = (int)Math.Min(BlockSize, offset);
        offset -= length;
        // A marker can straddle this block and the already scanned block to its right.
        var lookahead = (int)Math.Min(marker.Length - 1, fileLength - offset - length);
        var scanLength = length + lookahead;
        file.Position = offset;
        file.ReadExactly(block.AsSpan(0, scanLength));
        var end = length;

        while (end > 0)
        {
            var newline = block.AsSpan(0, end).LastIndexOf((byte)'\n');
            var start = newline + 1;
            if (!containsMarker)
            {
                var scanEnd = (int)Math.Min(scanLength, lineEnd - offset);
                containsMarker = block.AsSpan(start, scanEnd - start).IndexOf(marker) >= 0;
            }

            if (newline < 0 && offset > 0)
            {
                break;
            }

            if (containsMarker)
            {
                var lineLength = lineEnd - (offset + start);
                if (lineLength <= Array.MaxLength)
                {
                    var line = lineLength == end - start
                        ? block.AsMemory(start, end - start)
                        : ReadLine(file, offset + start, (int)lineLength);
                    if (TryReadAppliedEffort(line, out var effort))
                    {
                        return effort;
                    }
                }
            }

            containsMarker = false;
            lineEnd = offset + newline;
            end = newline;
        }
    }

    return null;
}

static byte[] ReadLine(FileStream file, long offset, int length)
{
    var line = new byte[length];
    file.Position = offset;
    file.ReadExactly(line);
    return line;
}

static bool TryReadAppliedEffort(ReadOnlyMemory<byte> line, out string? effort)
{
    effort = null;
    try
    {
        using var row = JsonDocument.Parse(line);
        var payload = Property(row.RootElement, "payload");
        if (StringValue(Property(row.RootElement, "type")) != "event_msg" ||
            StringValue(Property(payload, "type")) != "thread_settings_applied")
        {
            return false;
        }

        effort = StringValue(Property(Property(payload, "thread_settings"), "reasoning_effort"));
        return true;
    }
    catch (JsonException)
    {
        return false;
    }
}

static JsonElement Property(JsonElement value, string name) =>
    value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var child) ? child : default;

static string? StringValue(JsonElement value) =>
    value.ValueKind == JsonValueKind.String ? value.GetString() : null;
