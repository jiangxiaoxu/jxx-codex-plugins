using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static class HistoryMetadata
{
    internal static JsonObject Run(CliOptions args, HistorySource source) => args.Command switch
    {
        "inspect" => Inspect(source),
        "lineage" => Lineage(args.Home, source),
        "windows" => Windows(args, source),
        "tokens" => HistoryTokens.Run(args, source),
        "instructions" => Instructions(args, source),
        _ => throw new ArgumentException($"Unexpected metadata command: {args.Command}"),
    };

    private static JsonObject Inspect(HistorySource source)
    {
        const int recentLimit = 5;
        var recent = new Queue<JsonObject>(recentLimit);
        int count = 0;
        foreach (var (info, cursor) in Timeline(source, withTokens: false))
        {
            if (cursor is null)
                break;
            if (recent.Count == recentLimit)
                recent.Dequeue();
            recent.Enqueue(info);
            count++;
        }

        return new JsonObject
        {
            ["thread_id"] = source.ThreadId,
            ["segments"] = Segments(source),
            ["checkpoints"] = new JsonArray(recent.ToArray()),
            ["checkpoint_count"] = count,
        };
    }

    private static JsonObject Lineage(string home, HistorySource source)
    {
        var primary = source.Segments[^1];
        var current = primary;
        // Prefer the shard pinned by the child over the parent's latest rollout.
        var pinned = new Dictionary<string, HistorySegment>(StringComparer.Ordinal);
        foreach (var segment in source.Segments)
            if (segment.Header.Text("id") is { } id)
                pinned[id] = segment;

        var chain = new JsonArray();
        var seen = new HashSet<string?>(StringComparer.Ordinal);
        JsonObject end;
        while (true)
        {
            var header = current.Header;
            string? thread = header.Text("id");
            string? parent = header.Text("forked_from_id");
            seen.Add(thread);
            chain.Add((JsonNode?)new JsonObject
            {
                ["thread_id"] = thread,
                ["rollout_id"] = HistorySource.RolloutId(current.Path),
                ["path"] = current.Path,
                ["timestamp"] = header.Get("timestamp").ToNode(),
                ["forked_from_id"] = parent,
                ["forked_from_ordinal_exclusive"] = ForkBoundary(current, parent),
                ["spawned_by"] = HistorySource.SpawnParent(header),
                ["subagent_history_start_ordinal"] = header.Get("subagent_history_start_ordinal").ToNode(),
            });

            if (string.IsNullOrEmpty(parent))
            {
                end = new JsonObject { ["status"] = "root" };
                break;
            }
            if (seen.Contains(parent))
            {
                end = new JsonObject { ["status"] = "cycle", ["thread_id"] = parent };
                break;
            }
            if (pinned.TryGetValue(parent, out var ancestor))
            {
                current = ancestor;
                continue;
            }
            try
            {
                if (!Guid.TryParse(parent, out var parentId))
                    throw new CliInputException("invalid parent thread UUID");
                string? path = HistorySource.FindRollout(home, parentId.ToString("D"), current: true);
                if (path is null)
                {
                    end = new JsonObject { ["status"] = "missing", ["thread_id"] = parent };
                    break;
                }
                var parentHeader = HistorySource.ReadHeader(path);
                if (parentHeader.Text("id") != parent)
                    throw new CliInputException("thread identity does not match the rollout header");
                current = new HistorySegment(path, parent, parentHeader);
            }
            catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException
                or ArgumentException or CliInputException or RolloutReadException)
            {
                end = new JsonObject { ["status"] = "unreadable", ["thread_id"] = parent, ["error"] = error.Message };
                break;
            }
        }

        return new JsonObject
        {
            ["thread_id"] = source.ThreadId,
            ["root_session_id"] = primary.Header.Get("session_id").ToNode(),
            ["rollout_id"] = HistorySource.RolloutId(primary.Path),
            ["segments"] = Segments(source),
            ["fork_chain"] = chain,
            ["fork_chain_end"] = end,
        };
    }

    private static JsonArray Segments(HistorySource source)
    {
        var segments = new JsonArray();
        var primary = source.Segments[^1];
        foreach (var segment in source.Segments)
        {
            string? owner = segment.Header.Text("id");
            segments.Add((JsonNode?)new JsonObject
            {
                ["path"] = segment.Path,
                ["thread_id"] = owner,
                ["rollout_id"] = HistorySource.RolloutId(segment.Path),
                ["relation"] = segment == primary ? "current_rollout"
                    : owner is not null && owner == source.ThreadId ? "same_thread_history"
                    : "inherited_thread_history",
                ["size_bytes"] = new FileInfo(segment.Path).Length,
                ["end_ordinal_exclusive"] = segment.EndOrdinal,
                ["end_byte_offset"] = segment.EndOffset,
                ["subagent_history_start_ordinal"] = segment.Header.Get("subagent_history_start_ordinal").ToNode(),
                ["forked_from_id"] = segment.Header.Get("forked_from_id").ToNode(),
                ["spawned_by"] = HistorySource.SpawnParent(segment.Header),
            });
        }
        return segments;
    }

    private static JsonNode? ForkBoundary(HistorySegment segment, string? parent)
    {
        if (string.IsNullOrEmpty(parent))
            return null;
        var header = segment.Header;
        var boundary = header.Get("forked_from_ordinal_exclusive");
        var history = header.Get("history_base");
        if (boundary.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
            && (history.Text("thread_id") == parent || HistorySource.RolloutId(segment.Path) == header.Text("id")))
            boundary = history.Get("end_ordinal_exclusive");
        return boundary.ToNode();
    }

    private static JsonObject Windows(CliOptions args, HistorySource source)
    {
        string? window = args.One("--window");
        if (window is not (null or "current"))
            window = args.Integer("--window", 0, minimum: 0).ToString(CultureInfo.InvariantCulture);
        string origin = args.One("--origin") ?? "all";
        var since = args.Timestamp("--since");
        var until = args.Timestamp("--until");
        int limit = args.Integer("--limit", 20, minimum: 1);
        string? pending = args.One("--cursor");
        string? lastCursor = null;
        string? nextCursor = null;
        var items = new JsonArray();
        foreach (var (info, cursor) in Timeline(source, args.Has("--with-tokens")))
        {
            if ((window is not null && info["window"]!.ToString() != window)
                || (origin != "all" && info["origin"]!.GetValue<string>() != origin)
                || !Overlaps(info, since, until))
                continue;
            if (pending is not null)
            {
                if (pending == cursor)
                    pending = null;
                continue;
            }
            if (items.Count == limit)
            {
                nextCursor = lastCursor;
                break;
            }
            items.Add((JsonNode?)info);
            lastCursor = cursor;
        }
        if (pending is not null)
            throw new CliInputException("window cursor is outside the selected scope");
        return new JsonObject { ["thread_id"] = source.ThreadId, ["items"] = items, ["next_cursor"] = nextCursor };
    }

    private static IEnumerable<(JsonObject Info, string? Cursor)> Timeline(HistorySource source, bool withTokens)
    {
        var window = new WindowPeriod(withTokens);
        foreach (var row in source.Rows(scoped: false, includeRevision: false))
        {
            window.Add(row);
            if (row.Type != "compacted")
                continue;
            long? recorded = Count(row.Payload.Get("window_number"));
            yield return (window.Checkpoint(row, recorded), row.Cursor);
            window = new WindowPeriod(withTokens);
        }
        yield return (window.Current(source.ThreadId), null);
    }

    private sealed class WindowPeriod(bool withTokens)
    {
        private readonly HistoryTokens? usage = withTokens ? new HistoryTokens() : null;
        private RowLocation? first;
        private RowLocation? last;
        private (DateTimeOffset Time, string Text)? earliest;
        private (DateTimeOffset Time, string Text)? latest;
        private long records;

        internal void Add(HistoryRow row)
        {
            last = new RowLocation(row);
            first ??= last;
            records++;
            usage?.Add(row);
            if (row.Timestamp is not { } text || Instant(text) is not { } time)
                return;
            if (earliest is null || time < earliest.Value.Time
                || (time == earliest.Value.Time && string.CompareOrdinal(text, earliest.Value.Text) < 0))
                earliest = (time, text);
            if (latest is null || time > latest.Value.Time
                || (time == latest.Value.Time && string.CompareOrdinal(text, latest.Value.Text) > 0))
                latest = (time, text);
        }

        internal JsonObject Checkpoint(HistoryRow row, long? recorded)
        {
            var result = Location(row);
            result["ordinal"] = row.Value.Get("ordinal").ToNode();
            result["window"] = row.Window;
            result["window_inferred"] = row.Window != recorded;
            Complete(result, row.Timestamp);
            return result;
        }

        internal JsonObject Current(string? owner)
        {
            var result = new JsonObject
            {
                ["window"] = "current",
                ["last"] = last?.ToJson(),
                ["thread_id"] = owner,
                ["origin"] = "current",
            };
            Complete(result, null);
            return result;
        }

        private void Complete(JsonObject result, string? compactedAt)
        {
            result["start"] = first?.ToJson();
            result["compacted_at"] = compactedAt;
            result["first_at"] = earliest?.Text;
            result["last_at"] = latest?.Text;
            result["records"] = records;
            if (usage is not null)
                result["token_usage"] = usage.WindowReport();
        }
    }

    internal static JsonObject Location(HistoryRow row) => new RowLocation(row).ToJson();

    private readonly record struct RowLocation(string Path, long Line, string? Timestamp, string? ThreadId,
        string Origin, bool Copied, string? Parent)
    {
        internal RowLocation(HistoryRow row) : this(row.Path, row.Line, row.Timestamp, row.OwnerThreadId,
            row.Origin, row.Copied, row.Copied ? row.Segment.Header.Text("forked_from_id") : null) { }

        internal JsonObject ToJson()
        {
            var result = new JsonObject
            {
                ["path"] = Path,
                ["line"] = Line,
                ["timestamp"] = Timestamp,
                ["thread_id"] = ThreadId,
                ["origin"] = Origin,
            };
            if (Copied)
            {
                result["forked_from_thread_id"] = Parent;
                result["timestamp_origin"] = "copied_at";
            }
            return result;
        }
    }

    private static bool Overlaps(JsonObject info, DateTimeOffset? since, DateTimeOffset? until)
    {
        if (since is null && until is null)
            return true;
        return Instant(info["first_at"]?.GetValue<string>()) is { } first
            && Instant(info["last_at"]?.GetValue<string>()) is { } last
            && (since is null || since <= last)
            && (until is null || first < until);
    }

    private static DateTimeOffset? Instant(string? text) =>
        HistorySource.TryInstant(text, out var value) ? value : null;

    private static JsonObject Instructions(CliOptions args, HistorySource source)
    {
        int window = args.Integer("--window", 0, minimum: 0);
        int? item = args.One("--item") is null ? null : args.Integer("--item", 0, minimum: 0);
        int limit = args.Integer("--limit", 20, minimum: 1);
        int maxChars = args.Integer("--max-chars", 1_000, minimum: 1);
        int remaining = args.Integer("--budget-chars", 4_000, minimum: 1);
        var (start, end) = CharacterRange(args.One("--chars"));
        var roles = new HashSet<string>(args.Many("--role"), StringComparer.Ordinal);
        if (roles.Count == 0)
            roles.UnionWith(["system", "developer"]);
        HistoryRow? checkpoint = null;
        foreach (var row in source.Rows(scoped: false))
        {
            if (row.Type == "compacted" && row.Window == window)
                checkpoint = row;
        }
        if (checkpoint is null)
            throw new CliInputException($"no compaction checkpoint for window {window}");

        var cursor = args.One("--cursor");
        string? prefix = null;
        int after = -1;
        if (cursor is not null)
        {
            var parts = cursor.Split(':', 3);
            if (parts.Length != 3 || parts[0] != "ci1" || parts[1].Length != 24
                || !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out after))
                throw new CliInputException("invalid checkpoint instruction cursor; use next_cursor");
            prefix = InstructionCursor(checkpoint, window, roles, item, start, end);
            if (prefix + after.ToString(CultureInfo.InvariantCulture) != cursor)
                throw new CliInputException("checkpoint or instruction filters changed; start a new page");
        }

        var output = new JsonArray();
        string? next = null;
        int index = -1;
        int last = -1;
        foreach (var message in checkpoint.Payload.Get("replacement_history").Items())
        {
            index++;
            if (index <= after || (item is not null && item != index) || message.Text("type") != "message"
                || message.Text("role") is not { } role || !roles.Contains(role))
                continue;
            string instructions = string.Join('\n', InstructionParts(message));
            if (string.IsNullOrWhiteSpace(instructions))
                continue;
            int total = RecordProjection.CharacterCount(instructions);
            int stop = (int)Math.Min(end, total);
            if (stop <= start)
                continue;
            if (output.Count == limit || remaining == 0)
            {
                prefix ??= InstructionCursor(checkpoint, window, roles, item, start, end);
                next = prefix + last.ToString(CultureInfo.InvariantCulture);
                break;
            }
            int first = (int)start;
            int take = Math.Min(stop - first, Math.Min(maxChars, remaining));
            output.Add((JsonNode?)new JsonObject
            {
                ["role"] = role,
                ["kind"] = "compacted",
                ["path"] = checkpoint.Path,
                ["line"] = checkpoint.Line,
                ["window"] = window,
                ["checkpoint_item"] = index,
                ["text"] = RecordProjection.Slice(instructions, first, first + take),
                ["text_offset"] = first,
                ["text_total_chars"] = total,
                ["text_truncated"] = first + take < stop,
            });
            remaining -= take;
            last = index;
        }

        return new JsonObject { ["window"] = window, ["items"] = output, ["next_cursor"] = next };
    }

    private static IEnumerable<string> InstructionParts(JsonElement message)
    {
        foreach (var part in message.Get("content").Items())
            if (part.Text("type") is "input_text" or "inputText" or "output_text" or "text" or "Text" or "summary_text"
                && part.Text("text") is { Length: > 0 } text)
                yield return MediaText.OmitDataUrls(text);
    }

    private static string InstructionCursor(HistoryRow row, int window, HashSet<string> roles, int? item, long start, long end)
    {
        string selection = FormattableString.Invariant($"{row.Segment.Id}:{row.Line}:{row.Digest}:{window}:{roles.Contains("system")}:{roles.Contains("developer")}:{item}:{start}:{end}");
        return "ci1:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(selection)).AsSpan(0, 12)) + ':';
    }

    private static (long Start, long End) CharacterRange(string? value)
    {
        if (value is null)
            return (0, long.MaxValue);
        var parts = value.Split(':', 2);
        return (long.Parse(parts[0], CultureInfo.InvariantCulture), long.Parse(parts[1], CultureInfo.InvariantCulture));
    }

    internal static long? Count(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long count) && count >= 0 ? count : null;
}
