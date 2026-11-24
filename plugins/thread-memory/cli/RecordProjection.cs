using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static partial class RecordProjection
{
    internal const string ShellPrefix = "<user_shell_command>\n<command>\n";
    internal const string ShellSuffix = "\n</result>\n</user_shell_command>";
    private static readonly string[] ActivityLabels = [
        "id", "event_id", "agent_thread_id", "agent_path", "kind", "model", "reasoning_effort",
    ];
    private static readonly string[] SettingsLabels = [
        "model", "model_provider_id", "service_tier", "reasoning_effort", "reasoning_summary", "personality",
    ];

    [GeneratedRegex("^(?:file:|[a-z]:[/\\\\]|[/\\\\])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LocalReference();

    [GeneratedRegex("\\n</command>\\n<result>\\nExit code: -?[0-9]+\\nDuration: [0-9]+(?:\\.[0-9]+)? seconds\\nOutput:\\n")]
    private static partial Regex ShellResult();

    [GeneratedRegex("^[a-zA-Z][a-zA-Z0-9_]{0,63}$")]
    private static partial Regex ErrorType();

    internal static bool IsUserShellPart(string text, string? kind) => kind == "shell.user_command"
        || kind is null or "" or "unknown" && ShellBoundary(text) is not null;

    internal static Match? ShellBoundary(string text)
    {
        if (!text.StartsWith(ShellPrefix, StringComparison.Ordinal) || !text.EndsWith(ShellSuffix, StringComparison.Ordinal))
            return null;
        var match = ShellResult().Match(text, ShellPrefix.Length);
        return match.Success ? match : null;
    }

    internal static IEnumerable<(int Index, string Text)> UserShellParts(JsonElement item)
    {
        var kinds = item.Get("internal_chat_message_metadata_passthrough").Get("content_item_kinds");
        int index = 0;
        foreach (var part in item.Get("content").Items())
        {
            var kind = kinds.ValueKind == JsonValueKind.Array && index < kinds.GetArrayLength()
                ? kinds[index].StringValue() : null;
            if (part.Text("type") == "input_text" && part.Text("text") is { } text && IsUserShellPart(text, kind))
                yield return (index, text);
            index++;
        }
    }

    internal static IEnumerable<(string Name, string Text)> Values(JsonElement value, string field)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                if (value.StringValue() is { Length: > 0 } text)
                    yield return (field, text);
                break;
            case JsonValueKind.Array:
                int index = 0;
                foreach (var part in value.Items())
                    foreach (var nested in Values(part, $"{field}[{index++}]"))
                        yield return nested;
                break;
            case JsonValueKind.Object:
                if (value.Text("type") is "image" or "audio" or "input_image" or "inputImage" or "input_audio" or "inputAudio" or "encrypted_content")
                    break;
                foreach (var property in value.Properties())
                {
                    string key = property.Name.ToLowerInvariant();
                    if (key is "base64" or "b64_json" or "image_url" or "imageurl" or "audio_url" or "audiourl" or "raw_content" or "_meta" or "blob"
                        || key.StartsWith("encrypted", StringComparison.Ordinal) || key.EndsWith("base64", StringComparison.Ordinal))
                        continue;
                    var name = CharacterCount(property.Name) <= 80 && !MediaText.ContainsDataUrl(property.Name) ? property.Name : "[key]";
                    foreach (var part in Values(property.Value, $"{field}.{name}"))
                        yield return part;
                }
                break;
            case JsonValueKind.Number or JsonValueKind.True or JsonValueKind.False:
                yield return (field, value.GetRawText());
                break;
        }
    }

    internal static IEnumerable<(string Name, string Text)> Parts(JsonElement parts, string field, ISet<int>? excluded = null)
    {
        int index = 0;
        foreach (var part in parts.Items())
        {
            int current = index++;
            if (excluded?.Contains(current) is true)
                continue;
            string location = $"{field}[{current}]";
            switch (part.Text("type"))
            {
                case "input_text" or "inputText" or "output_text" or "text" or "Text" or "summary_text":
                    foreach (var value in Values(part.Get("text"), $"{location}.text"))
                        yield return value;
                    break;
                case "local_image" or "local_audio":
                    foreach (var value in Values(part.Get("path"), $"{location}.path"))
                        yield return value;
                    break;
                case "image" or "input_image" or "inputImage":
                    var reference = NonemptyText(part, "image_url") ?? NonemptyText(part, "imageUrl") ?? part.Text("url");
                    if (reference is not null && LocalReference().IsMatch(reference))
                        yield return ($"{location}.image_url", reference);
                    break;
            }
        }
    }

    internal static string? NonemptyText(JsonElement value, string field) =>
        value.Text(field) is { Length: > 0 } text ? text : null;

    internal static bool IsSummary(string? type) => type is "compaction" or "compaction_summary" or "context_compaction";

    internal static JsonObject? Encrypted(JsonElement envelope)
    {
        var payload = envelope.Get("payload");
        string? itemType = payload.Text("type");
        switch (envelope.Text("type"))
        {
            case "response_item" when (itemType == "reasoning" || IsSummary(itemType)) && HasEncryptedContent(payload):
                if (itemType == "reasoning")
                    return new JsonObject { ["kind"] = "encrypted_reasoning", ["tokens"] = null };
                if (IsSummary(itemType))
                    return new JsonObject { ["kind"] = "encrypted_summary", ["tokens"] = null };
                break;
            case "event_msg" when itemType is "agent_reasoning" or "agent_reasoning_raw_content"
                || itemType == "item_completed" && payload.Get("item").Text("type") == "Reasoning":
                return new JsonObject { ["kind"] = "reasoning", ["tokens"] = TokenCount(payload.Get("content_token_count")) };
            case "compacted" when payload.Get("replacement_history").Items().Any(item =>
                IsSummary(item.Text("type")) && HasEncryptedContent(item)):
                var usage = payload.Get("latest_token_usage_record");
                long? count = NonemptyText(payload, "compaction_response_id") is { } responseId
                    && usage.Text("response_id") == responseId ? TokenCount(usage.Get("usage").Get("output_tokens")) : null;
                return new JsonObject { ["kind"] = "encrypted_summary", ["tokens"] = count, ["scope"] = "compaction_response" };
        }
        return null;
    }

    private static bool HasEncryptedContent(JsonElement payload)
    {
        var value = payload.Get("encrypted_content");
        return value.ValueKind switch
        {
            JsonValueKind.String => !value.ValueEquals(ReadOnlySpan<byte>.Empty),
            JsonValueKind.Object => value.GetPropertyCount() > 0,
            JsonValueKind.Array => value.GetArrayLength() > 0,
            JsonValueKind.Number => !value.TryGetDouble(out double number) || number != 0,
            JsonValueKind.True => true,
            _ => false,
        };
    }

    private static long? TokenCount(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var tokens) && tokens >= 0 ? tokens : null;

    internal static JsonObject Location(HistoryRow row)
    {
        var physicalThread = row.Segment.Header.Text("id");
        var result = new JsonObject
        {
            ["rollout"] = Path.GetFileName(row.Path), ["path"] = row.Path, ["line"] = row.Line,
            ["timestamp"] = row.Timestamp, ["thread_id"] = physicalThread, ["origin"] = row.Origin,
        };
        if (row.Turn is not null)
            result["turn_id"] = row.Turn;
        if (row.Copied)
        {
            result["forked_from_thread_id"] = row.Segment.Header.Text("forked_from_id");
            result["timestamp_origin"] = "copied_at";
        }
        return result;
    }

    internal sealed record View(string Kind, string? ItemType, string? Role, IEnumerable<(string Name, string Text)> Fields,
        JsonObject? Tool, JsonObject? Encrypted);

    internal static (string Role, string Field, JsonElement Text)? VoiceTranscript(JsonElement payload)
    {
        // Both shapes are sealed, durable speech items. Realtime UI deltas and
        // model-input receipts have separate record types.
        string? type = payload.Text("type");
        bool frame = type == "frame";
        JsonElement speech = frame ? payload.Get("channels").Get("voice_transcript")
            : type == "transcript_segment" ? payload : default;
        string? role = speech.Text("role");
        JsonElement text = speech.Get("text");
        return role is "user" or "assistant" && text.ValueKind == JsonValueKind.String
            ? (role, frame ? "channels.voice_transcript.text" : "text", text) : null;
    }

    internal static View Project(HistoryRow row)
    {
        var kind = row.Type;
        var item = row.Payload;
        var type = item.Text("type");
        var tool = HistoryTools.Describe(row);
        var encrypted = Encrypted(row.Value);
        View Of(string? role, IEnumerable<(string Name, string Text)> fields) => new(kind, type, role, fields, tool, encrypted);
        if (kind == "session_meta" && item.Get("base_instructions").Text("text") is { } instructions)
        {
            type = "base_instructions";
            return Of("system", [("base_instructions.text", instructions)]);
        }
        if (kind == "turn_context")
        {
            var mode = item.Get("collaboration_mode");
            var settings = mode.Get("settings");
            bool nested = settings.ValueKind == JsonValueKind.Object;
            if ((nested ? settings : mode).Text("developer_instructions") is { } developer)
            {
                type = "developer_instructions";
                return Of("developer", [(nested ? "collaboration_mode.settings.developer_instructions" : "collaboration_mode.developer_instructions", developer)]);
            }
        }
        if (encrypted is not null)
        {
            if (type == "item_completed")
                type = "Reasoning";
            return Of("assistant", []);
        }
        if (kind == "retained_context" && type == "verified_answer")
            return Of("user", Questions(item, includeAnswers: true));
        if (kind == "retained_context" && type == "delivered_assistant_message")
            return Of("assistant", Strings(item, ["text"]));
        if (kind == "realtime_item")
            return VoiceTranscript(item) is { } voice ? Of(voice.Role, Values(voice.Text, voice.Field)) : Of(null, []);
        if (kind == "compacted")
        {
            type = null;
            return Of("assistant", Values(item.Get("message"), "message"));
        }
        if (kind == "inter_agent_communication")
        {
            type = null;
            return Of("assistant", Strings(item, ["content", "author", "recipient"]).Concat(Recipients(item)));
        }
        if (kind == "event_msg")
        {
            if (type is "user_message" or "agent_message" or "agent_reasoning")
            {
                if (type == "user_message")
                    return Of("user", UserEvent(item));
                return Of("assistant", Message(item).Concat(Questions(item, includeAnswers: false)));
            }
            if (type is "item_completed" or "item_started")
            {
                var eventType = type;
                item = item.Get("item");
                if (item.Text("type") is not { } nestedType)
                    return Of(null, []);
                type = nestedType;
                if (eventType == "item_started" && tool is null && !IsActivity(type))
                    return Of(null, []);
                if (type == "Extension" && item.Text("kind") is { } extension && extension is "image_gen.generation" or "web.search")
                    type = extension;
            }
            else if (tool is null && !IsImageResult(type))
                return Of(null, EventFields(type, item));
        }
        else if (kind != "response_item")
            return Of(null, []);

        string? role = item.Text("role");
        ISet<int>? excluded = null;
        if (type is "message" or "Message" && role == "user")
        {
            var shellParts = UserShellParts(item).Select(part => part.Index).ToHashSet();
            if (shellParts.Count > 0)
            {
                excluded = shellParts;
                if (shellParts.Count == item.Get("content").GetArrayLength())
                    role = "tool";
            }
        }
        else if (tool is not null || IsImageResult(type))
            role = "tool";
        else if (type is not ("message" or "Message"))
            role = type switch
            {
                "UserMessage" => "user",
                "agent_message" or "AgentMessage" or "reasoning" or "Reasoning" or "Plan" => "assistant",
                _ => null,
            };
        return Of(role, ResponseFields(type, item, tool, excluded));
    }

    private static bool IsActivity(string? type) => type is "SubAgentActivity" or "sub_agent_activity";
    private static bool IsImageResult(string? type) => type is "image_generation_end" or "ImageGeneration" or "image_gen.generation";

    private static IEnumerable<(string Name, string Text)> ResponseFields(string? type, JsonElement item, JsonObject? tool, ISet<int>? excluded)
    {
        if (tool is not null)
            foreach (var name in new[] { "call_id", "item_id", "tool_name", "tool_server", "tool_namespace" })
                if (tool[name] is JsonValue value && value.TryGetValue<string>(out var text))
                    yield return (name, text);
        if ((type is "message" or "Message" && item.Text("role") == "user") || (tool is null
            && type is "message" or "Message" or "agent_message" or "UserMessage" or "AgentMessage"))
            foreach (var part in Parts(item.Get("content"), "content", excluded))
                yield return part;
        else if (type == "reasoning")
            foreach (var part in Parts(item.Get("summary"), "summary"))
                yield return part;
        else if (type is "Reasoning" or "Plan")
        {
            string name = type == "Reasoning" ? "summary_text" : "text";
            foreach (var value in Values(item.Get(name), name))
                yield return value;
        }
        if (type == "AgentMessage")
            foreach (var question in Questions(item, includeAnswers: false))
                yield return question;
        if (IsActivity(type))
            foreach (var field in Strings(item, ActivityLabels))
                yield return field;
        var imageKeys = type switch
        {
            "image_generation_end" or "ImageGeneration" => new[] { "saved_path" },
            "image_gen.generation" => ["savedPath", "fileId"],
            _ => [],
        };
        foreach (var field in Strings(item, imageKeys))
            yield return field;
    }

    private static IEnumerable<(string Name, string Text)> UserEvent(JsonElement item) => Message(item)
        .Concat(Values(item.Get("local_images"), "local_images"))
        .Concat(Values(item.Get("local_audio"), "local_audio"));

    private static IEnumerable<(string Name, string Text)> Message(JsonElement item) =>
        Values(NonemptyText(item, "message") is not null ? item.Get("message") : item.Get("text"), "message");

    private static IEnumerable<(string Name, string Text)> Strings(JsonElement item, string[] keys, string prefix = "")
    {
        foreach (var key in keys)
            if (item.Text(key) is { } value)
                yield return (prefix + key, value);
    }

    private static IEnumerable<(string Name, string Text)> Questions(JsonElement item, bool includeAnswers)
    {
        int index = 0;
        foreach (var question in item.Get("questions").Items())
        {
            var prefix = $"questions[{index++}].";
            foreach (var field in Strings(question, includeAnswers ? ["question", "answer"] : ["title"], prefix))
                yield return field;
            if (includeAnswers)
                continue;
            int optionIndex = 0;
            foreach (var option in question.Get("options").Items())
            {
                if (option.StringValue() is { } text)
                    yield return ($"{prefix}options[{optionIndex}]", text);
                optionIndex++;
            }
        }
    }

    private static IEnumerable<(string Name, string Text)> Recipients(JsonElement item)
    {
        int index = 0;
        foreach (var recipient in item.Get("other_recipients").Items())
        {
            if (recipient.StringValue() is { } name)
                yield return ($"other_recipients[{index}]", name);
            index++;
        }
    }

    private static IEnumerable<(string Name, string Text)> EventFields(string? type, JsonElement item)
    {
        return type switch
        {
            "task_complete" or "turn_complete" => Errors(item.Get("error"), "error.").Concat(Strings(item, ["last_agent_message"])),
            "error" => Errors(item),
            "warning" => Strings(item, ["message"]),
            "thread_goal_updated" => Strings(item.Get("goal"), ["objective", "status"], "goal."),
            "thread_settings_applied" => Strings(item.Get("thread_settings"), SettingsLabels, "thread_settings.").Concat(
                Strings(item.Get("thread_settings").Get("collaboration_mode"), ["mode"], "thread_settings.collaboration_mode.")),
            "SubAgentActivity" or "sub_agent_activity" => Strings(item, ActivityLabels),
            _ => [],
        };
    }

    private static IEnumerable<(string Name, string Text)> Errors(JsonElement item, string prefix = "")
    {
        foreach (var field in Strings(item, ["message"], prefix))
            yield return field;
        var details = item.Get("codex_error_info");
        if (details.StringValue() is { } info)
            yield return ($"{prefix}codex_error_info", info);
        else if (details.ValueKind == JsonValueKind.Object && details.GetPropertyCount() == 1)
        {
            var property = details.EnumerateObject().First();
            if (!ErrorType().IsMatch(property.Name))
                yield break;
            yield return ($"{prefix}codex_error_info", property.Name);
            var status = property.Value.Get("http_status_code");
            if (status.ValueKind == JsonValueKind.Number && status.TryGetInt64(out _))
                yield return ($"{prefix}codex_error_info.http_status_code", status.GetRawText());
            foreach (var field in Strings(property.Value, ["turn_kind"], $"{prefix}codex_error_info."))
                yield return field;
        }
    }

    internal static JsonObject Details(HistoryRow row, View view)
    {
        var payload = row.Payload;
        var details = new JsonObject();
        string[] labels = [];
        string[] numbers = [];
        string[] flags = [];
        if (view.Kind == "inter_agent_communication")
        {
            labels = ["id", "author", "recipient"];
            flags = ["trigger_turn"];
            var recipients = payload.Get("other_recipients");
            if (recipients.ValueKind == JsonValueKind.Array)
            {
                var names = new JsonArray();
                foreach (var item in recipients.Items().Take(8))
                    if (item.StringValue() is { } name && CharacterCount(name) <= 128)
                        names.Add((JsonNode?)MediaText.OmitDataUrls(name));
                details["other_recipients"] = names;
                details["other_recipient_count"] = recipients.GetArrayLength();
            }
        }
        else if (view.Kind == "retained_context" && view.ItemType == "verified_answer")
            labels = ["call_id", "turn_id"];
        else if (view.Kind == "retained_context" && view.ItemType == "delivered_assistant_message")
        {
            labels = ["message_id", "turn_id", "phase"];
            flags = ["complete"];
        }
        else if (view.Kind == "event_msg")
        {
            switch (view.ItemType)
            {
                case "SubAgentActivity" or "sub_agent_activity":
                    if (payload.Text("type") is "item_started" or "item_completed")
                        payload = payload.Get("item");
                    labels = ActivityLabels;
                    numbers = ["occurred_at_ms"];
                    break;
                case "task_complete" or "turn_complete":
                    labels = ["turn_id", "root_turn_id"];
                    numbers = ["started_at", "completed_at", "duration_ms", "time_to_first_token_ms"];
                    details["has_error"] = payload.Get("error").ValueKind == JsonValueKind.Object;
                    break;
                case "thread_goal_updated":
                    labels = ["threadId", "turnId"];
                    var goal = payload.Get("goal");
                    AddLabels(details, goal, ["status"]);
                    AddNumbers(details, goal, ["tokenBudget", "tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"]);
                    break;
                case "thread_settings_applied":
                    labels = ["thread_id"];
                    var settings = payload.Get("thread_settings");
                    AddLabels(details, settings, SettingsLabels);
                    if (settings.Get("collaboration_mode").Text("mode") is { } mode && CharacterCount(mode) <= 256)
                        details["collaboration_mode"] = MediaText.OmitDataUrls(mode);
                    break;
                case "agent_message" or "AgentMessage":
                    if (view.ItemType == "AgentMessage")
                        payload = payload.Get("item");
                    labels = ["delivery", "phase"];
                    var questions = payload.Get("questions");
                    if (questions.ValueKind == JsonValueKind.Array)
                        details["question_count"] = questions.GetArrayLength();
                    break;
            }
        }
        AddLabels(details, payload, labels);
        AddNumbers(details, payload, numbers);
        foreach (var key in flags)
        {
            var value = payload.Get(key);
            if (value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                details[key] = value.GetBoolean();
        }
        return details;
    }

    private static void AddLabels(JsonObject details, JsonElement item, string[] labels)
    {
        foreach (var (name, value) in Strings(item, labels))
            if (CharacterCount(value) <= 256)
                details[name] = MediaText.OmitDataUrls(value);
    }

    private static void AddNumbers(JsonObject details, JsonElement item, string[] numbers)
    {
        foreach (var key in numbers)
        {
            var value = item.Get(key);
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long number))
                details[key] = number;
        }
    }

    internal static IEnumerable<(int Index, string Name, string Text)> Readable(IEnumerable<(string Name, string Text)> fields)
    {
        int index = 0;
        foreach (var (name, value) in fields)
        {
            var text = MediaText.OmitDataUrls(value);
            if (!string.IsNullOrWhiteSpace(text))
                yield return (index++, Slice(name, 0, 256), text);
        }
    }

    internal static int CharacterCount(string text, int end = int.MaxValue)
    {
        var span = text.AsSpan(0, Math.Min(end, text.Length));
        int pairs = 0;
        while (span.IndexOfAnyInRange('\ud800', '\udbff') is var first && first >= 0)
        {
            span = span[(first + 1)..];
            if (!span.IsEmpty && char.IsLowSurrogate(span[0]))
                pairs++;
        }
        return Math.Min(end, text.Length) - pairs;
    }

    internal static string Slice(string text, int start, int end)
    {
        if (start >= text.Length || start >= end)
            return "";
        var prefix = text.AsSpan(0, Math.Min(end, text.Length));
        if (prefix.IndexOfAnyInRange('\ud800', '\udbff') < 0)
            return text[start..prefix.Length];
        int first = CharacterOffset(text, start);
        return text[first..CharacterOffset(text, end, start, first)];
    }

    private static int CharacterOffset(string text, int target, int position = 0, int offset = 0)
    {
        while (position < target && offset < text.Length)
        {
            offset += char.IsSurrogatePair(text, offset) ? 2 : 1;
            position++;
        }
        return offset;
    }
}
