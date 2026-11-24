using System.Buffers;
using System.Buffers.Text;
using System.Globalization;
using System.Text.Json.Nodes;
using Meziantou.Framework.Imaging;
using Meziantou.Framework.Imaging.Formats;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static partial class HistoryMedia
{
    internal const int DefaultResolution = 1024;
    private const int DecodeChunk = 64 * 1024;
    private static readonly SearchValues<char> Base64Whitespace = SearchValues.Create(" \r\n\t");
    private static readonly ImageDecodeOptions PreviewDecode = new()
    {
        FrameLimit = 1,
        CmykConversion = new CmykConversionOptions(),
    };
    private static readonly WebPEncoder PreviewEncoder = new()
    {
        Compression = WebPCompression.Lossy,
        Quality = 80,
        MetadataHandling = MetadataHandling.Strip,
    };

    internal static string ExportDirectory(string? destination, string medium) => string.IsNullOrEmpty(destination)
        ? Directory.CreateTempSubdirectory($"codex-rollout-{medium}-").FullName
        : Path.GetFullPath(destination);

    private static JsonObject Export(CliOptions args, HistorySource source, string medium)
    {
        double scale = args.One("--scale") is string ratio ? double.Parse(ratio, CultureInfo.InvariantCulture) : 1;
        int resolution = args.Integer("--max-resolution", DefaultResolution);
        var requested = new List<string>();
        int invalidIdCount = 0;
        var found = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var targets = new Dictionary<HistoryRef, HashSet<string>>();
        foreach (string token in args.Many("--id").Distinct(StringComparer.Ordinal))
        {
            HistoryRef reference;
            try
            {
                reference = HistoryRef.Parse(token);
            }
            catch (CliInputException)
            {
                invalidIdCount++;
                continue;
            }
            if (reference.Kind != medium || reference.Index is null || reference.Start is not null ||
                reference.ToString() != token)
            {
                invalidIdCount++;
                continue;
            }
            requested.Add(token);
            var row = reference with { Kind = "record", Index = null };
            if (!targets.TryGetValue(row, out var ids))
                targets.Add(row, ids = new(StringComparer.Ordinal));
            ids.Add(token);
        }

        bool image = medium == "image";
        bool thumbnail = image && !args.Has("--original");
        string? outputDir = args.One("--output-dir");
        string? directory = null;
        var cache = new Dictionary<(string Kind, string Destination), JsonObject>();
        foreach (HistoryRow row in source.FindMany(targets.Keys))
        {
            var reference = new HistoryRef(row.Segment.Id, row.Line, row.Offset, row.Digest, "record", null);
            var ids = targets[reference];
            foreach (HistoryAttachment item in Scan(row, medium))
            {
                if (!ids.Contains(item.Id))
                    continue;
                var output = item.Public(attachments: !image);
                found.Add(item.Id, output);
                if (item.Kind == "reference" || item.Kind == "local" && item.ResolvedPath is null)
                {
                    output["export_error"] = UnavailableAttachment(item);
                    continue;
                }
                string identity = item.ResolvedPath ?? Digest(item);
                var key = (item.Kind, identity);
                if (!cache.TryGetValue(key, out JsonObject? export))
                {
                    if (thumbnail)
                    {
                        directory ??= ExportDirectory(outputDir, "images");
                        export = ExportImage(item, directory, scale, resolution, item.ResolvedPath is null ? identity : null);
                    }
                    else
                        export = ExportOriginal(item, outputDir, ref directory, identity);
                    cache.Add(key, export);
                }
                foreach (var (field, value) in export)
                    output[field] = value?.DeepClone();
            }
        }

        var result = new JsonObject
        {
            [image ? "images" : "attachments"] = new JsonArray(requested.Where(found.ContainsKey).Select(id => (JsonNode)found[id]).ToArray()),
            ["unknown_ids"] = new JsonArray(requested.Where(id => !found.ContainsKey(id)).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()),
        };
        if (invalidIdCount != 0)
            result["invalid_id_count"] = invalidIdCount;
        if (directory is not null)
            result[image ? "image_output_dir" : "audio_output_dir"] = directory;
        return result;
    }

    internal static JsonObject ExportImage(HistoryAttachment item, string directory, double scale, int? maxResolution, string? digest = null)
    {
        if (item.Kind == "reference" || item.Kind == "local" && item.ResolvedPath is null)
            return new() { ["export_error"] = UnavailableAttachment(item) };

        byte[]? original = null;
        int originalSize = 0;
        bool inline = item.Kind == "inline";
        if (inline)
        {
            if (item.Raw is null)
                return new() { ["export_error"] = "The inline image could not be read from the rollout." };
            try
            {
                var encoded = item.Raw.AsSpan(Base64Start(item.Raw, "image"));
                long upperBound = (long)(encoded.Length / 4) * 3;
                if (upperBound > ImageResourceLimits.Default.MaxEncodedBytes + 2)
                    throw new FormatException("The encoded image exceeds the thumbnail decoder's size limit.");
                original = new byte[upperBound];
                if (encoded.IsEmpty || encoded.ContainsAny(Base64Whitespace) ||
                    !Convert.TryFromBase64Chars(encoded, original, out originalSize))
                    throw new FormatException("Invalid Base64 image payload.");
            }
            catch (FormatException error)
            {
                return new() { ["export_error"] = MediaText.OmitDataUrls(error.Message) };
            }
        }

        string? thumbnail = null;
        try
        {
            using var source = inline ? null : new FileStream(item.ResolvedPath!, FileMode.Open,
                FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var picture = original is not null
                ? Image.Load<Rgba32>(original.AsSpan(0, originalSize), PreviewDecode)
                : Image.Load<Rgba32>(source!, PreviewDecode);
            picture.AutoOrient();
            var longestEdge = Math.Max(picture.Width, picture.Height);
            if (maxResolution is int cap && cap < longestEdge)
                scale = Math.Min(scale, (double)cap / longestEdge);
            int width = Math.Max(1, (int)Math.Round(picture.Width * scale));
            int height = Math.Max(1, (int)Math.Round(picture.Height * scale));
            if (width != picture.Width || height != picture.Height)
                picture.Resize(new ResizeOptions(width, height) { Filter = ResamplingFilter.Lanczos3 });

            Directory.CreateDirectory(directory);
            string name = inline ? digest ?? Digest(item) : $"local-{Hash(item.ResolvedPath!)}";
            var frame = picture.PosterFrame ?? picture.Frames[0];
            thumbnail = WriteNew(directory, $"{name}-{width}x{height}", ".webp", output => frame.Save(output, PreviewEncoder));
            var result = new JsonObject
            {
                ["thumbnail_file"] = thumbnail,
                ["thumbnail_width"] = width,
                ["thumbnail_height"] = height,
            };
            if (original is not null)
            {
                string extension = ImageExtension(picture.Metadata.SourceFormat);
                result["embedded_file"] = WriteNew(directory, name, extension, stream => stream.Write(original, 0, originalSize));
            }
            return result;
        }
        catch (Exception error) when (error is ImageException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            if (thumbnail is not null)
                File.Delete(thumbnail);
            return new() { ["export_error"] = $"Could not create an image thumbnail: {MediaText.OmitDataUrls(error.Message)}" };
        }
    }

    private static JsonObject ExportOriginal(HistoryAttachment item, string? outputDir, ref string? directory, string digest)
    {
        bool image = item.Media == "image";
        string field = image ? "original_file" : "audio_file";
        try
        {
            if (item.ResolvedPath is string path)
            {
                if (!File.Exists(path))
                    throw new FileNotFoundException($"The recorded {item.Media} file is unavailable.");
                return new() { [field] = path };
            }
            string raw = item.Raw ?? "";
            int start = Base64Start(raw, item.Media);
            var encoded = raw.AsSpan(start);
            if (encoded.IsEmpty)
                throw new FormatException($"Inline {item.Media} payload is empty.");
            if (encoded.ContainsAny(Base64Whitespace) || !Base64.IsValid(encoded))
                throw new FormatException($"Invalid Base64 {item.Media} payload.");

            byte[] buffer = ArrayPool<byte>.Shared.Rent(DecodeChunk * 3 / 4);
            try
            {
                int next = DecodeBase64Chunk(raw, start, item.Media, buffer, out int written);
                string extension = image ? OriginalImageExtension(item.MediaType, buffer.AsSpan(0, written)) : AudioExtension(item.MediaType);
                string destination = directory ?? ExportDirectory(outputDir, image ? "images" : "audio");
                Directory.CreateDirectory(destination);
                string file = WriteNew(destination, image ? digest : $"audio-{digest[..24]}", extension, output =>
                {
                    output.Write(buffer, 0, written);
                    for (int offset = next; offset < raw.Length;)
                    {
                        offset = DecodeBase64Chunk(raw, offset, item.Media, buffer, out int count);
                        output.Write(buffer, 0, count);
                    }
                });
                directory = destination;
                return new() { [field] = file };
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }
        catch (Exception error) when (error is FormatException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new() { ["export_error"] = MediaText.OmitDataUrls(error.Message) };
        }
    }

    private static int DecodeBase64Chunk(string raw, int offset, string medium, byte[] buffer, out int written)
    {
        int length = Math.Min(DecodeChunk, raw.Length - offset);
        if (!Convert.TryFromBase64Chars(raw.AsSpan(offset, length), buffer, out written))
            throw new FormatException($"Invalid Base64 {medium} payload.");
        return offset + length;
    }

    private static string OriginalImageExtension(string? mimeType, ReadOnlySpan<byte> bytes)
    {
        ImageFormat format = Image.DetectFormat(bytes);
        if (format != ImageFormat.Unknown)
            return ImageExtension(format);
        if (ImageFormatInfo.TryGetByMimeType(mimeType, out var info))
            return ImageExtension(info.Format);
        return mimeType == "image/svg+xml" ? ".svg" : ".image";
    }

    private static string ImageExtension(ImageFormat format)
    {
        if (format == ImageFormat.Jpeg)
            return ".jpeg";
        string extension = ImageFormatInfo.Get(format).DefaultFileExtension;
        return extension.StartsWith('.') ? extension : '.' + extension;
    }

    private static string AudioExtension(string? mediaType) => mediaType switch
    {
        "audio/wav" or "audio/wave" or "audio/x-wav" => ".wav",
        "audio/aac" => ".aac",
        "audio/flac" => ".flac",
        "audio/mp4" => ".m4a",
        "audio/mpeg" => ".mp3",
        "audio/ogg" => ".ogg",
        "audio/webm" => ".webm",
        _ => ".audio",
    };

    private static string UnavailableAttachment(HistoryAttachment item) => item.Kind == "reference"
        ? $"The rollout contains an opaque file ID or remote {item.Media} reference."
        : $"No absolute local path for the recorded {item.Media}.";

    private static string WriteNew(string directory, string prefix, string extension, Action<FileStream> write)
    {
        for (int attempt = 0; ; attempt++)
        {
            string name = attempt == 0 ? prefix : $"{prefix}-{attempt}";
            string candidate = Path.Combine(directory, name + extension);
            FileStream output;
            try
            {
                output = new FileStream(candidate, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            }
            catch (IOException error) when ((error.HResult & 0xffff) is 80 or 183)
            {
                continue;
            }
            try
            {
                using (output)
                    write(output);
                return candidate;
            }
            catch
            {
                File.Delete(candidate);
                throw;
            }
        }
    }
}
