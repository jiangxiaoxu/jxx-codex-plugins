using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static partial class HistoryChat
{
    public static JsonObject Run(CliOptions args, HistorySource source)
    {
        string? cursor = args.One("--cursor");
        int? last = args.Has("--last") ? args.Integer("--last", 0, minimum: 1) : null;
        string? phase = args.One("--phase") switch
        {
            "commentary" => "commentary",
            "partial" => "partial_answer",
            "final" => "final_answer",
            _ => null,
        };
        var roles = args.Many("--role");
        bool user = phase is null && (roles.Count == 0 || roles.Contains("user"));
        bool assistant = roles.Count == 0 || roles.Contains("assistant");

        int limit = last ?? args.Integer("--limit", 20, minimum: 1);
        int remaining = args.Integer("--budget-chars", 4000, minimum: 1);
        int previewLimit = Math.Min(args.Integer("--max-chars", 1000, minimum: 1), remaining);
        if (last.HasValue && source.TryTailRows(
                rows => ReadTail(rows, user, assistant, phase, limit, remaining, previewLimit), out var tail))
            return tail!;

        var page = new Queue<(JsonObject Message, string Cursor, int Chars)>();
        string? next = null;
        bool waiting = cursor is not null;
        foreach (HistoryRow row in source.Rows())
        {
            if (waiting)
            {
                waiting = row.Cursor != cursor;
                continue;
            }

            var message = Project(row, user, assistant, phase, out _);
            if (message is null)
                continue;
            string body = message["text"]!.GetValue<string>();
            int textChars = RecordProjection.CharacterCount(body);
            int length = Math.Min(textChars, previewLimit);
            if (last.HasValue)
            {
                while (page.Count == limit || length > remaining)
                    remaining += page.Dequeue().Chars;
            }
            else if (page.Count == limit || length > remaining)
            {
                next = page.Last().Cursor;
                break;
            }

            SetExcerpt(message, body, textChars, length);
            page.Enqueue((message, row.Cursor, length));
            remaining -= length;
        }
        if (waiting)
            throw new CliInputException("transcript cursor is outside the selected rollout range");
        return new JsonObject
        {
            ["items"] = new JsonArray(page.Select(entry => (JsonNode)entry.Message).ToArray()),
            ["next_cursor"] = next,
        };
    }

    private static JsonObject ReadTail(IEnumerable<HistoryRow> rows, bool user, bool assistant,
        string? phase, int limit, int remaining, int previewLimit)
    {
        var page = new List<JsonNode>();
        foreach (HistoryRow row in rows)
        {
            var message = Project(row, user, assistant, phase, out _);
            if (message is null)
                continue;
            string body = message["text"]!.GetValue<string>();
            int textChars = RecordProjection.CharacterCount(body);
            int length = Math.Min(textChars, previewLimit);
            if (length > remaining)
                break;
            SetExcerpt(message, body, textChars, length);
            page.Add(message);
            if (page.Count == limit)
                break;
            remaining -= length;
        }
        page.Reverse();
        return new JsonObject { ["items"] = new JsonArray(page.ToArray()), ["next_cursor"] = null };
    }

    private static void SetExcerpt(JsonObject message, string body, int total, int length)
    {
        if (length == total)
            return;
        message["text"] = RecordProjection.Slice(body, 0, length);
        message["omitted_chars"] = total - length;
    }

    public static JsonObject? Project(HistoryRow row) => Project(row, out _);

    public static JsonObject? Project(HistoryRow row, out IReadOnlyList<int> attachmentIndices) =>
        Project(row, true, true, null, out attachmentIndices);

    public static (JsonObject Message, IReadOnlyList<int> AttachmentIndices) VerifyReference(HistoryRow row, HistoryRef reference)
    {
        var message = Project(row, out var indices);
        if (message is null || row.Ref("transcript") != reference.ToString())
            throw new CliInputException("rollout reference is stale or no longer matches the selected view");
        return (message, indices);
    }

    private static JsonObject? Project(HistoryRow row, bool user, bool assistant, string? phase,
        out IReadOnlyList<int> attachmentIndices)
    {
        attachmentIndices = Array.Empty<int>();
        JsonElement payload = row.Payload;
        string? role;
        string? recordedPhase;
        string? turn = row.Turn;
        string body;
        bool asynchronous = false;
        int images = 0;
        int audio = 0;
        if (row.Type == "response_item" && row.ItemType == "message")
        {
            role = payload.Text("role");
            recordedPhase = payload.Text("phase");
            JsonElement metadata = row.Value.Get("metadata");
            if ((role == "user" ? !user : role != "assistant" || !assistant) ||
                (phase is not null && phase != recordedPhase) ||
                metadata.Get("compaction_output").ValueKind == JsonValueKind.True ||
                (metadata.Get("inherited_user_message").ValueKind == JsonValueKind.True && row.Origin != "inherited"))
                return null;
            var content = ChatParts(payload, role == "user", recovery: false);
            body = string.Join('\n', content.Text);
            attachmentIndices = content.Attachments;
            images = content.Images;
            audio = content.Audio;
            turn ??= payload.Get("internal_chat_message_metadata_passthrough").Text("turn_id");
        }
        else if (phase is null && row.Type == "realtime_item" && RecordProjection.VoiceTranscript(payload) is { } voice)
        {
            role = voice.Role;
            if (role == "user" ? !user : !assistant)
                return null;
            body = voice.Text.StringValue() ?? "";
            recordedPhase = null;
        }
        else if (row.Type == "event_msg" && assistant)
        {
            JsonElement item = row.ItemType == "item_completed" ? payload.Get("item") : payload;
            recordedPhase = item.Text("phase");
            if (item.Text("delivery") != "async" || phase is not null && phase != recordedPhase)
                return null;
            if (row.ItemType == "item_completed" && item.Text("type") == "AgentMessage")
                body = string.Join('\n', item.Get("content").Items()
                    .Where(part => part.Text("type") == "Text").Select(part => part.Text("text")));
            else if (row.ItemType == "agent_message")
                body = item.Text("message") ?? "";
            else
                return null;
            role = "assistant";
            asynchronous = true;
            turn ??= payload.Text("turn_id");
        }
        else
            return null;

        if (body.Length == 0 && attachmentIndices.Count == 0)
            return null;
        var result = new JsonObject
        {
            ["timestamp"] = row.Timestamp,
            ["role"] = role,
            ["text"] = MediaText.OmitDataUrls(body),
            ["turn_id"] = turn,
            ["path"] = row.Path,
            ["line"] = row.Line,
            ["ref"] = row.Ref("transcript"),
        };
        AddProvenance(row, result);
        if (!string.IsNullOrEmpty(recordedPhase))
            result["phase"] = recordedPhase;
        if (asynchronous)
            result["delivery"] = "async";
        if (images > 0)
            result["image_count"] = images;
        if (audio > 0)
            result["audio_count"] = audio;
        return result;
    }

    internal static (List<string> Text, List<int> Attachments, int Images, int Audio) ChatParts(
        JsonElement item, bool user, bool recovery)
    {
        var kinds = item.Get("internal_chat_message_metadata_passthrough").Get("content_item_kinds");
        List<string> text = [];
        List<int> attachments = [];
        int imageCount = 0;
        int audioCount = 0;
        int index = -1;
        foreach (var part in item.Get("content").Items())
        {
            ++index;
            string? kind = kinds.ValueKind == JsonValueKind.Array && index < kinds.GetArrayLength()
                ? kinds[index].StringValue() : null;
            bool unclassified = string.IsNullOrEmpty(kind) || kind == "unknown";
            bool visible = !user || unclassified || kind!.StartsWith("user.", StringComparison.Ordinal);
            string? type = part.Text("type");
            if (type is "input_image" or "input_audio")
            {
                if (visible || recovery && type == "input_image")
                {
                    attachments.Add(index);
                    if (type == "input_image")
                        ++imageCount;
                    else
                        ++audioCount;
                }
                continue;
            }
            if (!visible || type is not ("input_text" or "output_text") || part.Text("text") is not string value)
                continue;
            string trimmed = value.Trim();
            if (trimmed.Length == 0 || user && (recovery
                    ? RecordProjection.IsUserShellPart(value, kind) || ContextPrefix(trimmed)
                    : unclassified && (ContextPrefix(trimmed) || ContextBlock().IsMatch(trimmed))))
                continue;
            text.Add(value);
        }
        return (text, attachments, imageCount, audioCount);
    }

    internal static void AddProvenance(HistoryRow row, JsonObject result)
    {
        result["thread_id"] = row.OwnerThreadId;
        result["origin"] = row.Origin;
        if (row.Copied)
        {
            result["forked_from_thread_id"] = row.Segment.Header.Text("forked_from_id");
            result["timestamp_origin"] = "copied_at";
        }
    }

    private static bool ContextPrefix(string text) =>
        text.StartsWith("# AGENTS.md instructions", StringComparison.Ordinal) ||
        text.StartsWith("<environment_context>", StringComparison.Ordinal) ||
        text.StartsWith("Another language model started to solve this problem", StringComparison.Ordinal);

    [GeneratedRegex(@"\A<(?<tag>agent_message_board_notification|codex_internal_context|environment_context|external_[a-zA-Z0-9_-]+|goal_context|hook_prompt|recommended_plugins|skill|subagent_notification|turn_aborted|user_instructions|user_shell_command)(?:\s+[^>]+)?>.*</\k<tag>>\z", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex ContextBlock();

    public static string FormatMarkdown(JsonObject result)
    {
        StringBuilder text = new("# Codex rollout transcript");
        if (result["items"] is JsonArray items)
            foreach (JsonNode? message in items)
            {
                if (message is null)
                    continue;
                text.Append(CultureInfo.InvariantCulture, $"\n\n## {message["timestamp"]?.GetValue<string>() ?? "Time unavailable"} - {message["role"]}\n\n{message["path"]}:{message["line"]}");
                if (message["origin"] is JsonNode origin)
                {
                    text.Append(CultureInfo.InvariantCulture, $" ({origin}");
                    if (message["timestamp_origin"]?.GetValue<string>() == "copied_at")
                        text.Append(", copied at the displayed time");
                    text.Append(')');
                }
                text.Append(CultureInfo.InvariantCulture, $"\n\n{message["text"]}");
                if (message["image_count"] is JsonNode images)
                    text.Append(CultureInfo.InvariantCulture, $"\n\n[Image attachments: {images}]");
                if (message["audio_count"] is JsonNode audio)
                    text.Append(CultureInfo.InvariantCulture, $"\n\n[Audio attachments: {audio}]");
                if (message["omitted_chars"] is JsonNode omitted)
                    text.Append(CultureInfo.InvariantCulture, $"\n\n[Excerpt omitted {omitted} characters.]");
            }
        if (result["next_cursor"] is JsonNode cursor)
            text.Append(CultureInfo.InvariantCulture, $"\n\nNext cursor: {cursor}");
        if (result["missing_base_rollouts"] is JsonArray gaps)
            text.Append("\n\nMissing rollout segments: ").AppendJoin(", ", gaps);
        if (result["damaged_records"] is JsonObject damaged && damaged["items"] is JsonArray issues)
        {
            text.Append(CultureInfo.InvariantCulture, $"\n\nDamaged records observed: {damaged["count"]}\n");
            foreach (JsonNode? issue in issues)
                if (issue is not null)
                    text.Append(CultureInfo.InvariantCulture, $"\n- {issue["path"]}:{issue["line"]}, byte {issue["byte_offset"]} ({issue["reason"]})");
        }
        return text.Append('\n').ToString();
    }
}
