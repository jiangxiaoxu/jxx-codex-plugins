using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static class HistoryRecovery
{
    private sealed record Message(JsonObject Locator, string Key, string Text, int Chars, int ImageCount);

    // Retain locators and fingerprints across a window, then fetch only the selected blobs.
    private sealed record Image(JsonObject Locator, string Row, HistoryAttachment Attachment,
        string ItemType, string? Key, bool EventPath);

    public static JsonObject Run(CliOptions args, HistorySource source)
    {
        int? selectedWindow = args.Has("--window") ? args.Integer("--window", 0, minimum: 0) : null;
        int maxMessages = args.Integer("--max-messages", 8, minimum: 0);
        int maxChars = args.Integer("--max-chars", 2400, minimum: 0);
        int maxImages = args.Integer("--max-images", 8, minimum: 0);
        int maxResolution = args.Integer("--max-resolution", HistoryMedia.DefaultResolution, minimum: 1);
        string? scaleArg = args.One("--scale");
        double scale = args.Has("--max-resolution") ? 1 : 0.25;
        if (scaleArg is not null && (!double.TryParse(scaleArg, NumberStyles.Float, CultureInfo.InvariantCulture, out scale) ||
            !(scale > 0 && scale <= 1)))
            throw new CliInputException("Image scale must be greater than 0 and at most 1");

        HistorySegment primary = source.Segments[^1];
        string status = selectedWindow.HasValue ? "window_not_found" : "no_compaction";
        JsonObject? selected = null;
        JsonObject? rollback = null;
        JsonObject? gap = null;
        JsonObject? selectedRollback = null;
        JsonObject? selectedGap = null;
        var checkpoints = new JsonArray();
        List<Message> history = [];
        List<Image> imageHistory = [];
        List<Image> eventImages = [];
        List<Message> missingMessages = [];
        List<Image> missingImages = [];
        List<Image> missingPaths = [];
        foreach (HistoryRow row in source.Rows(scoped: false))
        {
            if (row.Gap)
            {
                history.Clear();
                imageHistory.Clear();
                eventImages.Clear();
                gap = new JsonObject { ["rollout"] = Path.GetFileName(row.Path), ["next_valid_line"] = row.Line };
                if (!selectedWindow.HasValue && selected is not null)
                {
                    selected = null;
                    missingMessages.Clear();
                    missingImages.Clear();
                    missingPaths.Clear();
                    status = "gap_after_checkpoint";
                }
            }

            if (row.Type == "event_msg" && row.ItemType == "thread_rolled_back" &&
                row.Payload.Get("num_turns") is { ValueKind: JsonValueKind.Number } count &&
                count.TryGetInt64(out long turns) && turns > 0)
            {
                history.Clear();
                imageHistory.Clear();
                eventImages.Clear();
                rollback = new JsonObject { ["rollout"] = Path.GetFileName(row.Path), ["line"] = row.Line };
                if (!selectedWindow.HasValue && selected is not null)
                {
                    selected = null;
                    missingMessages.Clear();
                    missingImages.Clear();
                    missingPaths.Clear();
                    status = "rollback_after_checkpoint";
                }
                continue;
            }

            if (row.Type == "response_item")
            {
                var images = ResponseImages(row, row.Payload, row.Value.Get("metadata"), null,
                    HistoryMedia.Scan(row, "image"));
                if (ChatMessage(row, row.Payload, row.Value.Get("metadata"), null, images, maxChars) is { } message)
                    history.Add(message);
                imageHistory.AddRange(images);
            }
            else if (row.Type == "event_msg")
            {
                JsonElement item = row.ItemType == "item_completed" ? row.Payload.Get("item") : row.Payload;
                if (HistoryChat.AsyncAssistantBody(row.ItemType, item) is { Length: > 0 } body)
                    history.Add(ProjectMessage(row, null, "assistant", body, 0, [], maxChars));

                string? itemType = item.Text("type");
                if (itemType is not ("user_message" or "UserMessage" or "view_image_tool_call" or "ImageView"
                    or "image_generation_end" or "ImageGeneration" or "Extension") ||
                    itemType == "Extension" && item.Text("kind") != "image_gen.generation")
                    continue;
                foreach (HistoryAttachment attachment in HistoryMedia.Scan(row, "image"))
                {
                    if (attachment.Kind == "local" && (attachment.ResolvedPath is not null || itemType is "user_message" or "UserMessage"))
                        eventImages.Add(MakeImage(row, attachment, row.ItemType!, eventPath: true));
                    else if (attachment.Kind != "local" && itemType is "image_generation_end" or "ImageGeneration" or "Extension")
                        imageHistory.Add(MakeImage(row, attachment, row.ItemType!));
                }
            }
            else if (row.Type == "compacted")
            {
                var checkpoint = new JsonObject
                {
                    ["rollout"] = Path.GetFileName(row.Path),
                    ["compaction_line"] = row.Line,
                    ["window_number"] = row.Window,
                };
                HistoryChat.AddProvenance(row, checkpoint);
                checkpoints.Add((JsonNode)checkpoint);
                bool use = selectedWindow.HasValue ? selectedWindow == row.Window
                    : row.Segment.Id == primary.Id && row.Origin == "current";
                if (use)
                {
                    selected = checkpoint;
                    selectedRollback = rollback;
                    selectedGap = gap;
                    status = "no_replacement_history";
                    missingMessages.Clear();
                    missingImages.Clear();
                    missingPaths.Clear();
                }

                JsonElement replacement = row.Payload.Get("replacement_history");
                if (replacement.ValueKind != JsonValueKind.Array)
                {
                    history.Clear();
                    imageHistory.Clear();
                    eventImages.Clear();
                    continue;
                }
                var mediaByItem = HistoryMedia.Scan(row, "image").ToLookup(attachment => attachment.CheckpointItem);
                List<Message> retained = [];
                List<Image> retainedImages = [];
                JsonElement annotations = row.Payload.Get("replacement_history_metadata");
                int index = 0;
                foreach (JsonElement item in replacement.Items())
                {
                    JsonElement metadata = annotations.ValueKind == JsonValueKind.Array && index < annotations.GetArrayLength()
                        ? annotations[index] : default;
                    List<Image> images = ResponseImages(row, item, metadata, index, mediaByItem[index]);
                    if (ChatMessage(row, item, metadata, index, images, maxChars) is { } message)
                        retained.Add(message);
                    retainedImages.AddRange(images);
                    ++index;
                }

                if (use)
                {
                    status = "ok";
                    var seenMessages = retained.Select(message => message.Key).ToHashSet(StringComparer.Ordinal);
                    for (int i = history.Count - 1; i >= 0; --i)
                        if (seenMessages.Add(history[i].Key))
                            missingMessages.Add(history[i]);
                    (missingImages, missingPaths) = MissingImages(imageHistory, eventImages, retainedImages);
                }
                history = retained;
                imageHistory = retainedImages;
                eventImages.Clear();
            }
        }

        JsonObject result = selected is null ? new JsonObject() : (JsonObject)selected.DeepClone();
        result["status"] = status;
        result["checkpoints"] = checkpoints;
        JsonObject? relevantRollback = selected is null ? rollback : selectedRollback;
        JsonObject? relevantGap = selected is null ? gap : selectedGap;
        if (relevantRollback is not null)
            result["history_ignored_through_rollback"] = relevantRollback;
        if (relevantGap is not null)
            result["history_ignored_through_gap"] = relevantGap;
        result["candidate_count"] = missingMessages.Count;
        result["messages"] = SelectMessages(missingMessages, maxMessages, maxChars, maxImages > 0);
        AddImageReport(result, missingImages, missingPaths, maxImages, args, source, scale, maxResolution);
        return result;
    }

    private static Message? ChatMessage(HistoryRow row, JsonElement item, JsonElement metadata,
        int? checkpointItem, List<Image> images, int maxChars)
    {
        string? role = item.Text("role");
        if (item.Text("type") != "message" || role is not ("user" or "assistant") ||
            metadata.Get("compaction_output").ValueKind == JsonValueKind.True)
            return null;
        var parts = HistoryChat.ChatParts(item, role == "user", recovery: true);
        if (parts.Text.Count == 0 && parts.Images == 0)
            return null;
        return ProjectMessage(row, checkpointItem, role, string.Join('\n', parts.Text), parts.Images, images, maxChars);
    }

    private static Message ProjectMessage(HistoryRow row, int? checkpointItem, string role, string body,
        int imageCount, IReadOnlyList<Image> images, int maxChars)
    {
        // Use the exact unredacted body to detect duplicate content, not the bounded excerpt.
        string fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body.Trim())));
        string key = role + ":" + fingerprint + ":" + string.Concat(images.Select(image =>
            (image.Key?.Length ?? -1).ToString(CultureInfo.InvariantCulture) + ":" + image.Key));
        string text = maxChars > 0 ? MediaText.OmitDataUrls(body) : "";
        int chars = RecordProjection.CharacterCount(text);
        if (chars > maxChars)
            text = RecordProjection.Slice(text, 0, maxChars);
        JsonObject locator = Location(row, checkpointItem);
        locator["role"] = role;
        return new Message(locator, key, text, chars, imageCount);
    }

    private static List<Image> ResponseImages(HistoryRow row, JsonElement item, JsonElement metadata,
        int? checkpointItem, IEnumerable<HistoryAttachment> source)
    {
        string? type = item.Text("type");
        if (type == "message" && (item.Text("role") is not ("user" or "assistant") ||
            metadata.Get("compaction_output").ValueKind == JsonValueKind.True) ||
            type is not ("message" or "custom_tool_call_output" or "function_call_output" or "item_completed" or "image_generation_call"))
            return [];
        JsonElement parts = item.Get(type == "message" ? "content" : "output");
        List<Image> images = [];
        foreach (var attachment in source)
        {
            if (attachment.CheckpointItem != checkpointItem || parts.ValueKind == JsonValueKind.Array &&
                (attachment.Part >= parts.GetArrayLength() || parts[attachment.Part].Text("type") != "input_image"))
                continue;
            // Recovery used only absolute image_url paths in response items. Legacy attachment events
            // may resolve a user path against the working directory instead.
            HistoryAttachment candidate = attachment;
            if (attachment.Kind == "local" && attachment.Path is string path && HistoryMedia.LocalPath(path) is null)
                candidate = attachment with { Kind = "reference", Reference = path, ResolvedPath = null };
            images.Add(MakeImage(row, candidate, type!));
        }
        return images;
    }

    private static Image MakeImage(HistoryRow row, HistoryAttachment attachment, string itemType, bool eventPath = false)
    {
        string? key = attachment.Kind switch
        {
            "inline" => "inline:" + HistoryMedia.Digest(attachment),
            "local" when attachment.ResolvedPath is not null => "local:" + attachment.ResolvedPath.ToUpperInvariant(),
            "local" => "event:" + row.Segment.Id + ":" + attachment.Path?.ToUpperInvariant(),
            _ when attachment.Reference is not null => "reference:" + attachment.Reference,
            _ => null,
        };
        return new Image(Location(row, attachment.CheckpointItem), row.Ref(), attachment with { Raw = null },
            itemType, key, eventPath);
    }

    private static JsonObject Location(HistoryRow row, int? checkpointItem)
    {
        var locator = new JsonObject { ["rollout"] = Path.GetFileName(row.Path), ["line"] = row.Line };
        HistoryChat.AddProvenance(row, locator);
        if (checkpointItem.HasValue)
            locator["checkpoint_item"] = checkpointItem.Value;
        return locator;
    }

    private static (List<Image> InlineOrReference, List<Image> Paths) MissingImages(List<Image> history,
        List<Image> eventPaths, List<Image> retained)
    {
        var seen = retained.Where(image => image.Key is not null).Select(image => image.Key!).ToHashSet(StringComparer.Ordinal);
        List<Image> missing = [];
        for (int i = history.Count - 1; i >= 0; --i)
        {
            Image image = history[i];
            if (image.Key is null || seen.Add(image.Key))
                missing.Add(image);
        }
        missing.Reverse();

        seen = retained.Where(image => image.Attachment.Kind == "local" && image.Key is not null)
            .Select(image => image.Key!).ToHashSet(StringComparer.Ordinal);
        List<Image> paths = [];
        foreach (Image image in missing.Where(image => image.Attachment.Kind == "local").Reverse().Concat(eventPaths.AsEnumerable().Reverse()))
            if (image.Key is null || seen.Add(image.Key))
                paths.Add(image);
        paths.Reverse();
        return (missing.Where(image => image.Attachment.Kind != "local").ToList(), paths);
    }

    private static JsonArray SelectMessages(List<Message> messages, int limit, int chars, bool includeImageOnly)
    {
        List<JsonNode> selected = [];
        if (limit <= 0 || chars <= 0)
            return new JsonArray();
        foreach (Message message in messages)
        {
            if (!includeImageOnly && message.Chars == 0)
                continue;
            var result = (JsonObject)message.Locator.DeepClone();
            result["text"] = message.Chars > chars ? RecordProjection.Slice(message.Text, 0, chars) : message.Text;
            if (message.ImageCount > 0)
                result["image_count"] = message.ImageCount;
            if (message.Chars > chars)
                result["truncated"] = true;
            selected.Add(result);
            chars -= Math.Min(message.Chars, chars);
            if (selected.Count == limit || chars == 0)
                break;
        }
        selected.Reverse();
        return new JsonArray(selected.ToArray());
    }

    private static void AddImageReport(JsonObject result, List<Image> candidates, List<Image> paths, int limit,
        CliOptions args, HistorySource source, double scale, int? maxResolution)
    {
        int inlineCount = candidates.Count(image => image.Attachment.Kind == "inline");
        int inlineBudget = limit > 1 && paths.Count > 0 ? limit - 1 : limit;
        int localSlots = Math.Min(limit - Math.Min(inlineBudget, inlineCount), paths.Count);
        int inlineSlots = Math.Min(inlineCount, inlineBudget);
        int referenceSlots = Math.Min(limit - inlineSlots - localSlots, candidates.Count - inlineCount);
        var selectedPaths = paths.TakeLast(localSlots).ToList();
        var chosen = candidates.Where(image => image.Attachment.Kind == "inline").TakeLast(inlineSlots)
            .Concat(candidates.Where(image => image.Attachment.Kind != "inline").TakeLast(referenceSlots)).ToHashSet();
        string? directory = null;
        if (args.Has("--export-images") && (inlineSlots > 0 || localSlots > 0))
        {
            string? configured = args.One("--export-images");
            directory = string.IsNullOrEmpty(configured)
                ? Directory.CreateTempSubdirectory("codex-rollout-images-").FullName
                : Directory.CreateDirectory(configured).FullName;
            result["image_export_dir"] = directory;
        }

        var imageRecords = new JsonArray();
        var inline = new Dictionary<string, (Image Image, JsonObject Report)>(StringComparer.Ordinal);
        foreach (var group in candidates.Where(chosen.Contains).GroupBy(image => (image.Row, image.Attachment.CheckpointItem)))
        {
            Image first = group.First();
            JsonObject record = (JsonObject)first.Locator.DeepClone();
            record["item_type"] = first.ItemType;
            if (first.ItemType == "message")
                record["role"] = first.Attachment.Role;
            var rows = new JsonArray();
            foreach (Image image in group.OrderBy(image => image.Attachment.Part))
            {
                JsonObject metadata = DescribeImage(image);
                if (directory is not null && image.Attachment.Kind == "inline")
                    inline.Add(image.Attachment.Id, (image, metadata));
                rows.Add((JsonNode)metadata);
            }
            record["images"] = rows;
            imageRecords.Add((JsonNode)record);
        }
        if (directory is not null && inline.Count > 0)
            ExportInline(inline, source, directory, scale, maxResolution);

        var pathRecords = new JsonArray();
        foreach (Image image in selectedPaths)
        {
            JsonObject metadata = (JsonObject)image.Locator.DeepClone();
            string? path = Redact(image.Attachment.Path);
            metadata["image_id"] = image.Attachment.Id;
            metadata["path"] = path;
            if (!image.EventPath)
            {
                metadata["part"] = image.Attachment.Part;
                metadata["reference"] = path;
                metadata["item_type"] = image.ItemType;
            }
            if (image.Attachment.ResolvedPath is not null)
                metadata["resolved_path"] = Redact(image.Attachment.ResolvedPath);
            if (directory is not null)
                Export(image, image.Attachment, metadata, directory, scale, maxResolution);
            pathRecords.Add((JsonNode)metadata);
        }
        result["image_candidate_count"] = candidates.Count;
        result["local_image_candidate_count"] = paths.Count;
        result["image_records"] = imageRecords;
        result["local_images"] = pathRecords;
    }

    private static void ExportInline(Dictionary<string, (Image Image, JsonObject Report)> images,
        HistorySource source, string directory, double scale, int? maxResolution)
    {
        var references = images.Values.Select(entry => HistoryRef.Parse(entry.Image.Row)).Distinct().ToArray();
        string? readError = null;
        try
        {
            foreach (HistoryRow row in source.FindMany(references))
                foreach (var attachment in HistoryMedia.Scan(row, "image"))
                    if (images.Remove(attachment.Id, out var entry))
                        Export(entry.Image, attachment, entry.Report, directory, scale, maxResolution);
        }
        catch (Exception error) when (error is RolloutReadException or HistoryIndexUnavailable or IOException or UnauthorizedAccessException)
        {
            readError = MediaText.OmitDataUrls(error.Message);
        }
        foreach (var (image, report) in images.Values)
        {
            var locator = image.Locator;
            report["export_error"] = readError is null
                ? $"Missing image in {locator["rollout"]} at line {locator["line"]}"
                : $"Could not read {locator["rollout"]} at line {locator["line"]}: {readError}";
        }
    }

    private static JsonObject DescribeImage(Image image)
    {
        var result = new JsonObject
        {
            ["part"] = image.Attachment.Part,
            ["image_id"] = image.Attachment.Id,
        };
        if (image.Attachment.Kind == "inline")
        {
            result["media_type"] = image.Attachment.MediaType;
            result["data_url_sha256"] = image.Key!["inline:".Length..];
        }
        else
            result["reference"] = Redact(image.Attachment.Reference);
        return result;
    }

    private static void Export(Image image, HistoryAttachment data, JsonObject output, string directory,
        double scale, int? maxResolution)
    {
        try
        {
            string? digest = data.Kind == "inline" ? image.Key!["inline:".Length..] : null;
            foreach (var (name, value) in HistoryMedia.ExportImage(data, directory, scale, maxResolution, digest))
                output[name] = value?.DeepClone();
        }
        catch (Exception error) when (error is IOException or ArgumentException or UnauthorizedAccessException or FormatException)
        {
            string message = MediaText.OmitDataUrls(error.Message);
            output["export_error"] = image.EventPath ? message
                : $"{image.Locator["rollout"]}:{image.Locator["line"]}: {message}";
        }
    }

    private static string? Redact(string? text) => text is null ? null : MediaText.OmitDataUrls(text);
}
