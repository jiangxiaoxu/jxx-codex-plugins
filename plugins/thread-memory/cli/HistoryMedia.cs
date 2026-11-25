using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Meziantou.Framework.Imaging;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal sealed record HistoryAttachment(
    string Id, string Media, string Kind, int Part, int? CheckpointItem,
    string? ItemType, string? Role, string? ItemId, string Rollout, long Line,
    string RecordType, string Origin, string? ThreadId, bool Copied, string? ForkedFromThreadId,
    string? Timestamp, string? TurnId,
    string? Path, string? ResolvedPath, string? Reference, string? MediaType, string? Raw)
{
    public JsonObject Locator()
    {
        var result = new JsonObject
        {
            ["rollout"] = Rollout,
            ["line"] = Line,
            ["record_type"] = RecordType,
            ["origin"] = Origin,
            ["part"] = Part,
        };
        foreach (var (name, value) in new[]
        {
            ("thread_id", ThreadId), ("timestamp", Timestamp), ("turn_id", TurnId),
            ("item_type", ItemType), ("item_id", ItemId), ("role", Role),
        })
            if (!string.IsNullOrEmpty(value))
                result[name] = MediaText.OmitDataUrls(value);
        if (Copied)
        {
            result["timestamp_origin"] = "copied_at";
            result["forked_from_thread_id"] = ForkedFromThreadId;
        }
        if (CheckpointItem is int checkpoint)
            result["checkpoint_item"] = checkpoint;
        return result;
    }

    public JsonObject Public(bool attachments)
    {
        var result = Locator();
        result["kind"] = Kind;
        if (Path is not null)
            result["path"] = MediaText.OmitDataUrls(Path);
        if (ResolvedPath is not null)
            result["resolved_path"] = MediaText.OmitDataUrls(ResolvedPath);
        if (Reference is not null)
            result["reference"] = MediaText.OmitDataUrls(Reference);
        if (MediaType is not null)
            result["media_type"] = MediaType;
        if (Media == "image")
            result["image_id"] = Id;
        if (attachments)
        {
            result["attachment_id"] = Id;
            result["media"] = Media;
            result["availability"] = Kind switch
            {
                "inline" => "embedded",
                "local" when ResolvedPath is null => "unresolved",
                _ => Kind,
            };
        }
        return result;
    }
}

internal static partial class HistoryMedia
{
    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif",
    };

    [GeneratedRegex(@"\Adata:((?:image|audio)/[a-z0-9.+-]+);base64,", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DataHeader();

    [GeneratedRegex(@"\A(?:image|audio)/[a-z0-9.+-]+\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Mime();

    [GeneratedRegex(@"\A[a-z][a-z0-9+.-]*:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UriScheme();

    [GeneratedRegex(@"\A(?:file:|[a-z]:[/\\]|[/\\])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LocalReference();

    internal static bool IsLocalImageReference(string reference) =>
        LocalReference().IsMatch(reference) && InlineMime(reference, "image") is null;

    private sealed record PartSource(string Kind, string? Raw, string? Path = null, string? ResolvedPath = null,
        string? MediaType = null, int? LegacyImageOrdinal = null);

    internal static JsonObject Run(CliOptions args, HistorySource source) => args.Command switch
    {
        "export-image" => Export(args, source, "image"),
        "export-audio" => Export(args, source, "audio"),
        _ => Catalog(args, source),
    };

    private static JsonObject Catalog(CliOptions args, HistorySource source)
    {
        bool attachments = args.Command == "attachments";
        string? media = attachments ? args.One("--media") : "image";
        string? kind = args.One("--kind");
        HashSet<string> roles = args.Many("--role").ToHashSet(StringComparer.Ordinal);
        string? cursor = args.One("--cursor");
        int limit = args.Integer("--limit", 20, minimum: 1, maximum: int.MaxValue);
        var items = new JsonArray();
        string? last = null;
        foreach (HistoryAttachment item in CatalogRows(args, source, media))
        {
            if ((kind is not null && item.Kind != kind) ||
                (roles.Count != 0 && (item.Role is null || !roles.Contains(item.Role))))
                continue;
            if (cursor is not null)
            {
                if (cursor == item.Id)
                    cursor = null;
                continue;
            }
            if (items.Count == limit)
                return new() { ["items"] = items, ["next_cursor"] = last };
            last = item.Id;
            items.Add((JsonNode)item.Public(attachments));
        }
        if (cursor is not null)
            throw new CliInputException("Attachment cursor is outside the selected rollout scope.");
        return new() { ["items"] = items, ["next_cursor"] = null };
    }

    private static IEnumerable<HistoryAttachment> CatalogRows(CliOptions args, HistorySource source, string? media)
    {
        if (args.One("--ref") is not string token)
        {
            foreach (HistoryRow row in source.Rows(includeToolBodies: true))
                foreach (HistoryAttachment item in Scan(row, media))
                    yield return item;
            yield break;
        }

        HistoryRef reference = HistoryRef.Parse(token);
        HistoryRow selected = source.Find(reference)
            ?? throw new CliInputException("Reference is stale or outside the selected rollout lineage.");
        if (reference.Kind == "transcript")
        {
            var (_, indices) = HistoryChat.VerifyReference(selected, reference);
            foreach (HistoryAttachment item in Scan(selected, media))
                if (indices.Contains(item.Part))
                    yield return item;
        }
        else
        {
            HistoryRecords.VerifyReference(selected, reference);
            foreach (HistoryAttachment item in Scan(selected, media))
                yield return item;
        }
    }

    internal static IEnumerable<JsonObject> Catalog(HistoryRow row)
    {
        foreach (HistoryAttachment item in Scan(row))
            yield return item.Public(attachments: true);
    }

    internal static IEnumerable<HistoryAttachment> Scan(HistoryRow row, string? media = null)
    {
        int imageOrdinal = 0, audioOrdinal = 0;
        foreach (var (checkpoint, payload) in MediaItems(row))
        {
            var item = payload.Text("type") == "item_completed" ? payload.Get("item") : payload;
            var kind = item.Text("type");
            if (kind is null)
                continue;
            string? role = kind switch
            {
                "UserMessage" or "user_message" => "user",
                "message" or "Message" => item.Text("role") is "function" ? "tool" : item.Text("role"),
                _ => "tool",
            };
            string? itemId = item.Text("id") ?? item.Text("call_id");
            int firstImageOrdinal = imageOrdinal;
            foreach (var (part, medium, source) in Parts(item, row.Cwd, media))
            {
                int index = medium == "image" ? imageOrdinal++ : audioOrdinal++;
                if (source.LegacyImageOrdinal is int legacyOrdinal)
                    index = firstImageOrdinal + legacyOrdinal;
                yield return new(
                    row.Ref(medium, index), medium, source.Kind, part, checkpoint, kind, role, itemId,
                    Path.GetFileName(row.Path), row.Line, row.Type, row.Origin, row.OwnerThreadId,
                    row.Copied, row.Copied ? row.Segment.Header.Text("forked_from_id") : null,
                    row.Timestamp, payload.Text("turn_id") ?? row.Turn, source.Path, source.ResolvedPath,
                    source.Kind == "reference" ? source.Raw : null, source.MediaType, source.Raw);
            }
        }
    }

    private static IEnumerable<(int? CheckpointItem, JsonElement Item)> MediaItems(HistoryRow row)
    {
        if (row.Type == "compacted")
        {
            int index = 0;
            foreach (JsonElement item in row.Payload.Get("replacement_history").Items())
                yield return (index++, item);
        }
        else if (row.Type is "event_msg" or "response_item")
            yield return (null, row.Payload);
    }

    private static IEnumerable<(int Part, string Media, PartSource Source)> Parts(JsonElement item, string? cwd, string? media)
    {
        string? kind = item.Text("type");
        int index = 0;
        List<(int Part, JsonElement Resource)>? embedded = null;
        bool mcp = kind is "McpToolCall" or "mcp_tool_call_end";
        foreach (JsonElement part in ContentParts(item, kind))
        {
            string? partKind = part.Text("type");
            if (mcp && partKind == "resource")
                (embedded ??= []).Add((index, part.Get("resource")));
            else
            {
                string medium = partKind is "image" or "input_image" or "inputImage" ? "image" : "audio";
                PartSource? source = media is not null && medium != media ? null :
                    medium == "image" ? ImagePart(part, partKind, cwd) : AudioPart(part, partKind, cwd);
                if (source is not null)
                    yield return (index, medium, source);
            }
            index++;
        }
        // Append newly recognized resource parts so existing direct-media IDs stay stable.
        if (embedded is not null)
        {
            foreach (var (part, resource) in embedded)
            {
                if (resource.Text("mimeType") is not string mime || !Mime().IsMatch(mime))
                    continue;
                string medium = mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ? "image" : "audio";
                if ((media is null || medium == media) && resource.Text("blob") is { Length: > 0 } blob)
                    yield return (part, medium, new("inline", blob, MediaType: mime.ToLowerInvariant()));
            }
        }

        if (kind == "user_message" && media != "audio")
        {
            index = 0;
            foreach (PartSource? source in LegacyImages(item, cwd))
            {
                if (source is not null)
                    yield return (index, "image", source);
                index++;
            }
        }
        if (kind == "user_message" && media != "image")
        {
            index = 0;
            foreach (PartSource? audio in LegacyAudio(item, cwd))
            {
                if (audio is not null)
                    yield return (index, "audio", audio);
                index++;
            }
        }

        if (media == "audio")
            yield break;
        if (kind is "image_generation_call" or "ImageGeneration" or "image_generation_end" || IsImageExtension(item))
        {
            string? fileId = item.Text("fileId") ?? item.Text("file_id");
            if (ImageSource(null, fileId, item.Text("result"), null, cwd) is { } generated)
                yield return (0, "image", generated);
        }

        index = 0;
        bool userAttachment = kind is "user_message" or "UserMessage";
        foreach (string? path in LocalImages(item, kind))
        {
            if (LocalSource(path, userAttachment ? cwd : null) is { } local &&
                (userAttachment || local.ResolvedPath is not null))
                yield return (index++, "image", local);
        }
    }

    private static IEnumerable<JsonElement> ContentParts(JsonElement item, string? kind) => kind switch
    {
        "message" or "Message" or "UserMessage" => item.Get("content").Items(),
        "FunctionCallOutput" or "function_call_output" or "custom_tool_call_output" => item.Get("output").Items(),
        "McpToolCall" or "mcp_tool_call_end" => McpContent(item).Items(),
        "DynamicToolCall" or "dynamic_tool_call_response" => item.Get("content_items").Items(),
        _ => [],
    };

    private static JsonElement McpContent(JsonElement item)
    {
        JsonElement result = item.Get("result");
        return (result.Get("Ok") is { ValueKind: JsonValueKind.Object } value ? value : result).Get("content");
    }

    private static IEnumerable<string?> LocalImages(JsonElement item, string? kind) => kind switch
    {
        "user_message" => item.Get("local_images").Items().Select(path => path.StringValue()),
        "UserMessage" => item.Get("content").Items().Where(part => part.Text("type") == "local_image").Select(part => part.Text("path")),
        "view_image_tool_call" or "ImageView" => [item.Text("path")],
        "ImageGeneration" => [item.Text("saved_path")],
        "image_generation_end" => new[] { item.Text("saved_path") }
            .Concat(item.Get("input_images").Items().Select(part => part.Text("path"))),
        "Extension" when IsImageExtension(item) => new[] { item.Text("savedPath") }
            .Concat(item.Get("inputImages").Items().Select(part => part.Text("path"))),
        _ => [],
    };

    private static bool IsImageExtension(JsonElement item) =>
        item.Text("type") == "Extension" && item.Text("kind") == "image_gen.generation";

    private static PartSource? ImagePart(JsonElement part, string? kind, string? cwd) =>
        ImageSource(part.Text(kind == "inputImage" ? "imageUrl" : "image_url"),
            part.Text("file_id"), part.Text("data"), part.Text("mimeType"), cwd);

    private static PartSource? ImageSource(string? url, string? file, string? data, string? mime, string? cwd)
    {
        if (IsDataUrl(file))
            url = file;
        else if (!string.IsNullOrEmpty(file))
            return new("reference", file);
        if (IsDataUrl(url))
            return new("inline", url, MediaType: HeaderMime(url!, "image") ?? "application/octet-stream");
        if (!string.IsNullOrEmpty(data))
            return new("inline", data, MediaType: HeaderMime(data, "image") ?? ValidMime(mime, "image")
                ?? InlineMime(data, "image") ?? "image/unknown");
        if (string.IsNullOrEmpty(url))
            return null;
        if (InlineMime(url, "image") is string inlineMime)
            return new("inline", url, MediaType: inlineMime);
        string? path = LocalPath(url);
        if (path is not null)
            return new("local", null, url, path);
        if (!UriScheme().IsMatch(url) && (cwd is not null || ImageExtensions.Contains(Path.GetExtension(url))))
            return LocalSource(url, cwd);
        return new("reference", url);
    }

    private static PartSource? AudioPart(JsonElement part, string? kind, string? cwd)
    {
        if (kind == "local_audio")
            return LocalSource(part.Text("path"), cwd);
        if (kind is not ("audio" or "input_audio" or "inputAudio"))
            return null;
        return AudioSource(part.Text(kind == "inputAudio" ? "audioUrl" : "audio_url"),
            part.Text("file_id"), kind == "audio" ? part.Text("data") : null, part.Text("mimeType"));
    }

    private static PartSource? AudioSource(string? url, string? file, string? data = null, string? mime = null)
    {
        if (IsDataUrl(file))
            url = file;
        else if (!string.IsNullOrEmpty(file))
            return new("reference", file);
        if (!string.IsNullOrEmpty(url))
        {
            if (IsDataUrl(url))
                return new("inline", url, MediaType: HeaderMime(url, "audio") ?? "audio/unknown");
            if (InlineMime(url, "audio") is string inlineMime)
                return new("inline", url, MediaType: inlineMime);
            if (LocalPath(url) is string path)
                return new("local", null, url, path);
            return new("reference", url);
        }
        return string.IsNullOrEmpty(data) ? null : new("inline", data,
            MediaType: HeaderMime(data, "audio") ?? ValidMime(mime, "audio") ?? "audio/unknown");
    }

    private static IEnumerable<PartSource?> LegacyImages(JsonElement item, string? cwd)
    {
        JsonElement images = item.Get("images"), files = item.Get("file_ids");
        var sources = images.Items().Select(image => ImageSource(image.StringValue(), null, null, null, cwd))
            .Concat(files.Items().Select(file => ImageSource(null, file.StringValue(), null, null, cwd)));
        if (images is { ValueKind: JsonValueKind.Array } && files is { ValueKind: JsonValueKind.Array } &&
            item.Get("image_order") is { ValueKind: JsonValueKind.Array } recordedOrder)
        {
            int imageCount = images.GetArrayLength(), fileCount = files.GetArrayLength();
            var order = recordedOrder.Items().Select(kind => kind.StringValue()).ToArray();
            if (imageCount > 0 && fileCount > 0 && order.Length == imageCount + fileCount &&
                order.Count(kind => kind == "inline") == imageCount && order.Count(kind => kind == "file") == fileCount)
            {
                // Present the original input order while keeping existing attachment IDs attached to the same images.
                int ordinal = 0;
                var indexed = sources.Select(source => source is null ? null : source with { LegacyImageOrdinal = ordinal++ })
                    .ToArray();
                int imageIndex = 0, fileIndex = imageCount;
                foreach (string? kind in order)
                    yield return indexed[kind == "inline" ? imageIndex++ : fileIndex++];
                yield break;
            }
        }
        foreach (PartSource? source in sources)
            yield return source;
    }

    private static IEnumerable<PartSource?> LegacyAudio(JsonElement item, string? cwd)
    {
        JsonElement references = item.Get("audio_references");
        var files = references.Items().ToArray();
        var urls = item.Get("audio").Items().ToArray();
        var order = item.Get("audio_order").Items().Select(part => part.StringValue()).ToArray();
        if (order.Length > 0 && order.Length == files.Length + urls.Length &&
            order.Count(type => type == "inline") == urls.Length && order.Count(type => type == "file") == files.Length &&
            files.All(part => part.ValueKind == JsonValueKind.Object && part.TryGetProperty("file_id", out _)))
        {
            int audio = 0, file = 0;
            foreach (string? type in order)
                yield return type == "inline" ? AudioSource(urls[audio++].StringValue(), null) : LegacyAudioFile(files[file++]);
        }
        else if (references.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement file in files)
                yield return LegacyAudioFile(file);
        }
        else
        {
            foreach (JsonElement url in urls)
                yield return AudioSource(url.StringValue(), null);
        }
        foreach (JsonElement path in item.Get("local_audio").Items())
            yield return LocalSource(path.StringValue(), cwd);
    }

    private static PartSource? LegacyAudioFile(JsonElement file) => AudioSource(file.Text("audio_url"), file.Text("file_id"));

    private static PartSource? LocalSource(string? path, string? cwd) =>
        string.IsNullOrEmpty(path) || IsDataUrl(path) ? null : new("local", null, path, LocalPath(path, cwd));

    internal static string? LocalPath(string name, string? cwd = null)
    {
        if (name.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
        {
            if (!Uri.TryCreate(name, UriKind.Absolute, out Uri? uri) || !uri.IsFile ||
                (!string.IsNullOrEmpty(uri.Host) && !uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) ||
                uri.Query.Length != 0 || uri.Fragment.Length != 0)
                return null;
            name = uri.Host.Length == 0 ? uri.LocalPath : uri.GetComponents(UriComponents.Path, UriFormat.Unescaped);
            cwd = null;
        }
        if (UriScheme().IsMatch(name) && (name.Length < 2 || name[1] != ':'))
            return null;
        try
        {
            if (!Path.IsPathFullyQualified(name))
            {
                if (cwd is null || !Path.IsPathFullyQualified(cwd))
                    return null;
                if (name.Length >= 2 && name[1] == ':' &&
                    !cwd.AsSpan().StartsWith(name.AsSpan(0, 2), StringComparison.OrdinalIgnoreCase))
                    return null;
                name = Path.GetFullPath(name, cwd);
            }
            else
                name = Path.GetFullPath(name);
            // Do not fetch remote file attachments over UNC. Extended drive paths are local.
            if (name.StartsWith("\\\\", StringComparison.Ordinal) &&
                !(name.StartsWith("\\\\?\\", StringComparison.Ordinal) && name.Length >= 7 && name[5] == ':'))
                return null;
            return name;
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or IOException)
        {
            return null;
        }
    }

    internal static bool IsDataUrl(string? value) =>
        value is not null && value.AsSpan().TrimStart().StartsWith("data:", StringComparison.OrdinalIgnoreCase);

    // A typed media URL can be recorded without its data-URL header. Recognize only media signatures.
    private static string? InlineMime(string value, string media)
    {
        if (Path.IsPathFullyQualified(value))
            return null;
        ReadOnlySpan<char> encoded = value.AsSpan().TrimStart();
        Span<char> compact = stackalloc char[32];
        int count = 0;
        foreach (char character in encoded)
        {
            if (character is ' ' or '\r' or '\n' or '\t')
                continue;
            compact[count++] = character;
            if (count == compact.Length)
                break;
        }
        count -= count % 4;
        Span<byte> prefix = stackalloc byte[24];
        if (count == 0 || !Convert.TryFromBase64Chars(compact[..count], prefix, out int length) ||
            Path.HasExtension(encoded))
            return null;
        var bytes = prefix[..length];
        if (media == "audio")
            return AudioMime(bytes);
        ImageFormat format = Image.DetectFormat(bytes);
        return format is ImageFormat.Unknown or ImageFormat.Tga ? null : ImageFormatInfo.Get(format).MimeType;
    }

    private static string? AudioMime(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 12 && bytes.StartsWith("RIFF"u8) && bytes[8..12].SequenceEqual("WAVE"u8))
            return "audio/wav";
        if (bytes.StartsWith("fLaC"u8))
            return "audio/flac";
        if (bytes.StartsWith("OggS\0"u8))
            return "audio/ogg";
        if (bytes is [(byte)'I', (byte)'D', (byte)'3', 2 or 3 or 4, ..])
            return "audio/mpeg";
        if (bytes.Length >= 12 && bytes[4..12].SequenceEqual("ftypM4A "u8))
            return "audio/mp4";
        if (bytes is [0x1a, 0x45, 0xdf, 0xa3, ..])
            return "audio/webm";
        if (bytes.StartsWith("ADIF"u8))
            return "audio/aac";
        return null;
    }

    private static string? HeaderMime(string value, string media)
    {
        if (!IsDataUrl(value))
            return null;
        var match = DataHeader().Match(value);
        return match.Success ? ValidMime(match.Groups[1].Value, media) : null;
    }

    private static string? ValidMime(string? value, string media) =>
        value is not null && value.StartsWith(media + "/", StringComparison.OrdinalIgnoreCase) && Mime().IsMatch(value)
            ? value.ToLowerInvariant() : null;

    internal static int Base64Start(string raw, string media)
    {
        if (!IsDataUrl(raw))
            return 0;
        var match = DataHeader().Match(raw);
        if (!match.Success || ValidMime(match.Groups[1].Value, media) is null)
            throw new FormatException($"Invalid Base64 {media} data URI.");
        return match.Length;
    }

    internal static string Digest(HistoryAttachment item)
    {
        string value = item.Raw ?? item.ResolvedPath ?? item.Path ?? "";
        if (item.Kind != "inline")
            return Hash(value);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        if (!IsDataUrl(value))
            digest.AppendData(Encoding.UTF8.GetBytes($"data:{item.MediaType};base64,"));
        int bufferSize = Math.Max(4, Math.Min(value.Length, 64 * 1024));
        byte[] buffer = ArrayPool<byte>.Shared.Rent(bufferSize);
        try
        {
            Encoder encoder = Encoding.UTF8.GetEncoder();
            ReadOnlySpan<char> remaining = value.AsSpan();
            while (!remaining.IsEmpty)
            {
                encoder.Convert(remaining, buffer, true, out int chars, out int bytes, out _);
                digest.AppendData(buffer.AsSpan(0, bytes));
                remaining = remaining[chars..];
            }
            return Convert.ToHexStringLower(digest.GetHashAndReset());
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
