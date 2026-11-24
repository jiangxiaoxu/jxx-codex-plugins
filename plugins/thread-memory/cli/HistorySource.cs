using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ThreadMemoryHook;
using ZstdSharp;

namespace ThreadMemoryCli;

internal sealed class HistoryLineReader : IDisposable
{
    private readonly Stream input;
    private readonly FileStream? ownedFile;
    private readonly bool ownsInput;
    private readonly byte[] buffer;
    private ArrayBufferWriter<byte>? longLine;
    private int begin;
    private int end;
    private bool disposed;

    internal HistoryLineReader(string path, long offset = 0)
    {
        ownedFile = OpenPlain(path);
        buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        try
        {
            bool compressed = IsCompressed(path);
            if (offset != 0)
            {
                if (compressed)
                    throw new ArgumentException("record cursors require an uncompressed rollout");
                ownedFile.Seek(offset, SeekOrigin.Begin);
            }
            input = compressed ? new DecompressionStream(ownedFile, leaveOpen: true) : ownedFile;
            ownsInput = compressed;
        }
        catch
        {
            ownedFile.Dispose();
            ArrayPool<byte>.Shared.Return(buffer);
            throw;
        }
    }

    // The index reads multiple non-contiguous records from one verified handle.
    internal HistoryLineReader(FileStream source)
    {
        input = source;
        buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
    }

    internal static bool IsCompressed(string path) => path.EndsWith(".zst", StringComparison.Ordinal);

    internal static FileStream OpenPlain(string path) =>
        new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, bufferSize: 1);

    internal void Seek(long offset)
    {
        input.Seek(offset, SeekOrigin.Begin);
        begin = end = 0;
    }

    // The result stays valid until the next read. A long line uses one buffer
    // which is retained only for the duration of that line.
    internal ReadOnlyMemory<byte> ReadLine(long remaining = long.MaxValue)
    {
        longLine = null;
        while (remaining > 0)
        {
            if (begin == end)
            {
                begin = 0;
                end = input.Read(buffer.AsSpan(0, (int)Math.Min(buffer.Length, remaining)));
                if (end == 0)
                    break;
            }
            int length = (int)Math.Min(end - begin, remaining);
            var available = buffer.AsMemory(begin, length);
            int newline = available.Span.IndexOf((byte)'\n');
            if (newline >= 0 || length == remaining)
            {
                int take = newline < 0 ? length : newline + 1;
                begin += take;
                if (longLine is null)
                    return available[..take];
                longLine.Write(available.Span[..take]);
                return longLine.WrittenMemory;
            }
            longLine ??= new ArrayBufferWriter<byte>(length + 1);
            longLine.Write(available.Span);
            begin += length;
            remaining -= length;
        }
        return longLine?.WrittenMemory ?? ReadOnlyMemory<byte>.Empty;
    }

    public void Dispose()
    {
        if (disposed)
            return;
        disposed = true;
        if (ownsInput)
            input.Dispose();
        ownedFile?.Dispose();
        ArrayPool<byte>.Shared.Return(buffer);
    }
}

internal static class HistoryWire
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonDocumentOptions DocumentOptions = new() { MaxDepth = 1_000 };

    internal static JsonElement Parse(ReadOnlySpan<byte> raw)
    {
        if (raw.StartsWith(Encoding.UTF8.Preamble))
            raw = raw[Encoding.UTF8.Preamble.Length..];
        _ = StrictUtf8.GetCharCount(raw);
        return JsonElement.Parse(raw, DocumentOptions);
    }

    internal static JsonDocument Borrow(ReadOnlyMemory<byte> raw)
    {
        if (raw.Span.StartsWith(Encoding.UTF8.Preamble))
            raw = raw[Encoding.UTF8.Preamble.Length..];
        _ = StrictUtf8.GetCharCount(raw.Span);
        return JsonDocument.Parse(raw, DocumentOptions);
    }

    internal static JsonElement Property(JsonElement obj, string name) => SessionFiles.Property(obj, name);

    internal static string? String(JsonElement obj, string name) => String(Property(obj, name));

    internal static string? String(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String)
            return null;
        try
        {
            return value.GetString();
        }
        catch (InvalidOperationException)
        {
            // System.Text.Json rejects an isolated surrogate escape on access.
            // Old rollout rows can contain one and jq needs printable output.
            return JsonElement.Parse(RepairSurrogates(value.GetRawText())).GetString();
        }
    }

    internal static string RenderRaw(JsonElement value)
    {
        string raw = value.GetRawText();
        return raw.Contains("\\ud", StringComparison.OrdinalIgnoreCase) ? RepairSurrogates(raw) : raw;
    }

    private static string RepairSurrogates(string raw)
    {
        var repaired = new StringBuilder(raw);
        for (int i = 1; i + 1 < raw.Length; i++)
        {
            if (raw[i] != '\\')
                continue;
            if (raw[i + 1] != 'u')
            {
                i++;
                continue;
            }
            ushort code = ushort.Parse(raw.AsSpan(i + 2, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            if (code is >= 0xd800 and <= 0xdbff && i + 12 < raw.Length
                && raw.AsSpan(i + 6).StartsWith("\\u", StringComparison.Ordinal)
                && ushort.Parse(raw.AsSpan(i + 8, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture) is >= 0xdc00 and <= 0xdfff)
            {
                i += 11;
                continue;
            }
            if (code is >= 0xd800 and <= 0xdfff)
            {
                repaired[i + 2] = 'f';
                repaired[i + 3] = 'f';
                repaired[i + 4] = 'f';
                repaired[i + 5] = 'd';
            }
            i += 5;
        }
        return repaired.ToString();
    }

    internal static long? Integer(JsonElement obj, string name)
    {
        var value = Property(obj, name);
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long result) ? result : null;
    }

    internal static bool Null(JsonElement value) => value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined;

    internal static bool Truthy(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => String(value)?.Length > 0,
        JsonValueKind.Number => !value.TryGetDouble(out double number) || number != 0,
        JsonValueKind.True => true,
        JsonValueKind.Array => value.GetArrayLength() > 0,
        JsonValueKind.Object => value.EnumerateObject().MoveNext(),
        _ => false,
    };

    internal static bool Optional(JsonElement value, JsonValueKind kind) => Null(value) || value.ValueKind == kind;

    internal static bool ValidEnvelope(JsonElement row)
    {
        var timestamp = Property(row, "timestamp");
        return String(row, "type") is { Length: > 0 }
            && Property(row, "payload").ValueKind == JsonValueKind.Object
            && timestamp.ValueKind is JsonValueKind.String or JsonValueKind.Undefined
            && Optional(Property(row, "metadata"), JsonValueKind.Object);
    }

    internal static bool ValidRecord(JsonElement row, bool salvage)
    {
        if (!ValidEnvelope(row))
            return false;
        string kind = String(row, "type")!;
        JsonElement payload = Property(row, "payload");
        JsonElement subtype = Property(payload, "type");
        if (kind is "event_msg" or "response_item" && !Optional(subtype, JsonValueKind.String))
            return false;
        string? subtypeName = String(subtype);
        JsonElement item = Property(payload, "item");
        if (kind == "event_msg" && subtypeName == "item_completed"
            && (item.ValueKind != JsonValueKind.Object || !Optional(Property(item, "type"), JsonValueKind.String)))
            return false;
        if (!salvage)
            return true;
        if (!ValidAnnotations(payload))
            return false;
        if (kind == "response_item")
            return ValidResponse(payload);
        return kind switch
        {
            "compacted" => ValidArray(Property(payload, "replacement_history"), ValidResponse)
                && ValidArray(Property(payload, "replacement_history_metadata"), entry => Optional(entry, JsonValueKind.Object)),
            "session_meta" or "turn_context" => Optional(Property(payload, "cwd"), JsonValueKind.String),
            "event_msg" => subtypeName switch
            {
                "thread_rolled_back" => Integer(payload, "num_turns") is >= 0,
                "user_message" => Property(payload, "local_images").ValueKind is JsonValueKind.Array or JsonValueKind.Undefined,
                "item_completed" => ValidCompletedItem(item),
                "agent_message" when String(payload, "delivery") == "async" => String(payload, "message") is not null,
                _ => true,
            },
            _ => true,
        };
    }

    private static bool ValidArray(JsonElement value, Func<JsonElement, bool> validate) =>
        Null(value) || value.ValueKind == JsonValueKind.Array && value.EnumerateArray().All(validate);

    private static bool ValidAnnotations(JsonElement payload)
    {
        var annotations = Property(payload, "internal_chat_message_metadata_passthrough");
        return Optional(annotations, JsonValueKind.Object)
            && ValidArray(Property(annotations, "content_item_kinds"), kind => kind.ValueKind == JsonValueKind.String);
    }

    private static bool ValidResponse(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || !ValidAnnotations(item))
            return false;
        var kind = Property(item, "type");
        if (!Optional(kind, JsonValueKind.String))
            return false;
        var parts = Property(item, "output");
        if (String(kind) == "message")
        {
            parts = Property(item, "content");
            if (String(item, "role") is null || parts.ValueKind != JsonValueKind.Array)
                return false;
        }
        else if (String(kind) is not ("function_call_output" or "custom_tool_call_output")
            || parts.ValueKind != JsonValueKind.Array)
        {
            return true;
        }
        return parts.EnumerateArray().All(part => part.ValueKind == JsonValueKind.Object
            && (String(part, "type") switch
            {
                "input_text" or "output_text" => String(part, "text") is not null,
                "input_image" => Optional(Property(part, "image_url"), JsonValueKind.String)
                    && Optional(Property(part, "file_id"), JsonValueKind.String),
                _ => true,
            }));
    }

    private static bool ValidCompletedItem(JsonElement item)
    {
        var content = Property(item, "content");
        return String(item, "type") switch
        {
            "UserMessage" => content.ValueKind == JsonValueKind.Undefined
                || content.ValueKind == JsonValueKind.Array && content.EnumerateArray().All(part => part.ValueKind == JsonValueKind.Object),
            "Extension" when String(item, "kind") == "image_gen.generation" => Optional(Property(item, "inputImages"), JsonValueKind.Array),
            "AgentMessage" when String(item, "delivery") == "async" => content.ValueKind == JsonValueKind.Array
                && content.EnumerateArray().All(part => part.ValueKind == JsonValueKind.Object
                    && (String(part, "type") != "Text" || String(part, "text") is not null)),
            _ => true,
        };
    }
}

internal sealed class HistorySource
{
    private const int MaxHeaderBytes = 32 * 1024 * 1024;
    private static readonly HashSet<string> TurnStart = ["task_started", "turn_started"];
    private static readonly HashSet<string> TurnEnd = ["task_complete", "turn_complete", "turn_aborted"];
    private readonly CliOptions options;
    private readonly bool allowIndex;
    private readonly bool salvage;
    private readonly Dictionary<(string Path, long Line), JsonObject> damage = [];

    private HistorySource(CliOptions options, List<HistorySegment> segments, JsonArray gaps, bool allowIndex)
    {
        this.options = options;
        this.allowIndex = allowIndex;
        salvage = options.Has("--salvage");
        Segments = segments;
        ThreadId = segments[^1].Header.Text("id");
        MissingBaseRollouts = gaps;
    }

    internal IReadOnlyList<HistorySegment> Segments { get; }
    internal string? ThreadId { get; }
    internal JsonArray MissingBaseRollouts { get; }
    internal JsonArray DamagedRecords => new(damage.Values.Select(item => item.DeepClone()).ToArray());

    internal static HistorySource Open(CliOptions options, bool allowIndex = true)
    {
        string? raw = options.One("--rollout");
        string? explicitThread = options.One("--thread");
        string? thread = explicitThread;
        string? path = raw is not null ? AvailablePath(raw) : null;
        if (raw is null)
        {
            thread ??= Environment.GetEnvironmentVariable("CODEX_THREAD_ID");
            if (string.IsNullOrEmpty(thread))
                throw new CliInputException("provide --thread or --rollout outside a Codex thread");
            if (!Guid.TryParse(thread, out var uuid))
                throw new CliInputException($"{(explicitThread is null ? "CODEX_THREAD_ID" : "--thread")} must be a thread UUID");
            thread = uuid.ToString("D");
            path = FindRollout(options.Home, thread, current: true)
                ?? throw new FileNotFoundException($"no local rollout found for thread {thread}");
        }
        else if (path is null)
        {
            throw new FileNotFoundException($"rollout file not found: {raw}", raw);
        }

        var overrides = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string previous in options.Many("--previous"))
        {
            if (RolloutId(previous) is not { } id || overrides.ContainsKey(id))
                throw new CliInputException($"expected a distinct Codex rollout filename for --previous: {previous}");
            overrides.Add(id, AvailablePath(previous)
                ?? throw new FileNotFoundException($"rollout file not found: {previous}", previous));
        }

        HistorySegment current = LoadSegment(path);
        if (thread is not null && thread != current.Header.Text("id")
            && (raw is null || thread != current.Header.Text("session_id")))
            throw new CliInputException("thread identity does not match the rollout header");

        var segments = new List<HistorySegment> { current };
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { current.Path };
        var gaps = new JsonArray();
        while (!HistoryWire.Null(current.Header.Get("history_base")))
        {
            var history = current.Header.Get("history_base");
            if (history.ValueKind != JsonValueKind.Object)
                throw new RolloutReadException("history_base must be an object", current.Path, 1);
            if (!Guid.TryParse(history.Text("thread_id"), out var uuid))
                throw new RolloutReadException("history_base.thread_id must be a UUID", current.Path, 1);
            string id = uuid.ToString("D");
            long? ordinal = HistoryWire.Integer(history, "end_ordinal_exclusive");
            long? offset = HistoryWire.Integer(history, "end_byte_offset");
            if (ordinal is null or <= 0 || offset is null or <= 0)
                throw new RolloutReadException(
                    "history_base cutoff requires positive end_ordinal_exclusive and end_byte_offset", current.Path, 1);

            string? parent = overrides.Remove(id, out string? pinned) ? pinned : FindRollout(options.Home, id);
            if (parent is null)
            {
                gaps.Add((JsonNode?)JsonValue.Create(id));
                break;
            }
            current = LoadSegment(parent, offset, ordinal);
            if (!visited.Add(current.Path))
                throw new RolloutReadException("rollout lineage cycle", current.Path, 1);
            segments.Add(current);
        }
        if (overrides.Count != 0)
            throw new CliInputException("unreferenced --previous rollout(s): " +
                string.Join(", ", overrides.Values.Select(Path.GetFileName)));

        segments.Reverse();
        return new HistorySource(options, segments, gaps, allowIndex);
    }

    internal static string? FindRollout(string home, string id, bool current = false)
    {
        try
        {
            string? path = SessionFiles.FindRollout(home, id, current, TryReadHeader);
            return path is null ? null : CanonicalPath(path);
        }
        catch (InvalidDataException error) when (!current)
        {
            throw new CliInputException(error.Message.TrimEnd('.') + "; specify --rollout or --previous");
        }
    }

    internal static JsonElement ReadHeader(string path)
    {
        using var lines = new HistoryLineReader(path);
        return ReadHeader(path, lines);
    }

    internal static JsonElement ReadHeader(string path, FileStream plain)
    {
        using var lines = new HistoryLineReader(plain);
        return ReadHeader(path, lines);
    }

    private static JsonElement ReadHeader(string path, HistoryLineReader lines)
    {
        var raw = ReadLine(lines, path, MaxHeaderBytes + 3L);
        int terminator = raw.Span.EndsWith("\r\n"u8) ? 2 : raw.Span.EndsWith("\n"u8) ? 1 : 0;
        if (raw.Length - terminator > MaxHeaderBytes)
            throw new RolloutReadException($"session_meta is larger than {MaxHeaderBytes} bytes", path, 1);
        if (!TryParse(raw, out var row, out string reason))
            throw new RolloutReadException($"invalid session_meta JSON ({reason})", path, 1);
        if (!HistoryWire.ValidEnvelope(row) || row.Text("type") != "session_meta")
            throw new RolloutReadException("expected a session_meta record", path, 1);
        var header = row.Get("payload");
        foreach (string name in new[] { "id", "session_id", "forked_from_id" })
        {
            if (!HistoryWire.Optional(header.Get(name), JsonValueKind.String))
                throw new RolloutReadException($"session_meta {name} must be a string", path, 1);
        }
        return header;
    }

    private static JsonElement TryReadHeader(string path)
    {
        try
        {
            return ReadHeader(path);
        }
        catch (RolloutReadException)
        {
            return default;
        }
    }

    private static HistorySegment LoadSegment(string path, long? offset = null, long? ordinal = null)
    {
        path = CanonicalPath(path);
        return new HistorySegment(path, SegmentId(path), ReadHeader(path), offset, ordinal);
    }

    private static string? AvailablePath(string path)
    {
        if (File.Exists(path))
            return path;
        string plain = HistoryLineReader.IsCompressed(path) ? path[..^4] : path;
        if (File.Exists(plain))
            return plain;
        return File.Exists(plain + ".zst") ? plain + ".zst" : null;
    }

    private static string CanonicalPath(string path)
    {
        using var file = HistoryLineReader.OpenPlain(path);
        string key = RolloutPath.Resolve(path, file).Key;
        if (key.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + key[8..];
        if (key.StartsWith(@"\\?\", StringComparison.Ordinal) && key.Length > 6 && key[5] == ':')
            return key[4..];
        return key;
    }

    private static string SegmentId(string path)
    {
        if (HistoryLineReader.IsCompressed(path))
            path = path[..^4];
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant())))[..16];
    }

    internal static string? RolloutId(string path)
    {
        string name = Path.GetFileName(path);
        if (HistoryLineReader.IsCompressed(name))
            name = name[..^4];
        return name.StartsWith("rollout-", StringComparison.Ordinal)
            && name.EndsWith(".jsonl", StringComparison.Ordinal)
            && name.Length >= 50
            && Guid.TryParseExact(name.AsSpan(name.Length - 42, 36), "D", out var id)
            ? id.ToString("D")
            : null;
    }

    internal static string? SpawnParent(JsonElement header) =>
        header.Text("parent_thread_id") is { Length: > 0 } parent ? parent
            : header.Get("source").Get("subagent").Get("thread_spawn").Text("parent_thread_id");

    internal static bool TryInstant(string? value, out DateTimeOffset instant)
    {
        instant = default;
        if (value is null || value.Length < 17 || value[10] != 'T')
            return false;
        int offset = value.LastIndexOfAny(['+', '-']);
        bool utc = value.EndsWith('Z');
        if (!utc && offset < 11)
            return false;

        // Rollout timestamps have nanosecond precision in some builds.
        // The prior CLI and SQLite index both compare at microsecond precision.
        int fraction = value.IndexOf('.', 11);
        int zone = utc ? value.Length - 1 : offset;
        if (fraction >= 0 && zone - fraction > 7)
        {
            if (value.AsSpan(fraction + 1, zone - fraction - 1).IndexOfAnyExceptInRange('0', '9') >= 0)
                return false;
            value = value[..(fraction + 7)] + value[zone..];
        }
        return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out instant);
    }

    internal static int CheckpointWindow(int previous, JsonElement payload) =>
        HistoryWire.Integer(payload, "window_number") is >= 0 and <= int.MaxValue and long explicitNumber
            ? (int)explicitNumber
            : FollowingWindow(previous);

    private static int FollowingWindow(int previous) => previous == int.MaxValue ? previous : previous + 1;

    private sealed record Scope(string? Segment, string? Turn, string Origin, long First, long? Last,
        DateTimeOffset? Since, DateTimeOffset? Until, string? Window)
    {
        internal static Scope Read(CliOptions args)
        {
            long first = 1;
            long? last = null;
            if (args.One("--lines") is { } lines)
            {
                string[] range = lines.Split(':');
                if (range.Length != 2 || !long.TryParse(range[0], NumberStyles.None, CultureInfo.InvariantCulture, out first)
                    || !long.TryParse(range[1], NumberStyles.None, CultureInfo.InvariantCulture, out long end)
                    || first < 1 || end < first)
                    throw new CliInputException("--lines requires an inclusive START:END range with positive line numbers");
                last = end;
            }
            DateTimeOffset? since = Boundary(args, "--since");
            DateTimeOffset? until = Boundary(args, "--until");
            if (since >= until)
                throw new CliInputException("--since must be earlier than --until");
            return new Scope(args.One("--segment"), args.One("--turn"), args.One("--origin") ?? "all", first, last,
                since, until, args.One("--window"));
        }

        private static DateTimeOffset? Boundary(CliOptions args, string option)
        {
            if (args.One(option) is not { } value)
                return null;
            if (TryInstant(value, out var instant))
                return instant;
            throw new CliInputException($"{option} expects an ISO 8601 timestamp with a UTC offset");
        }

        internal bool Selects(HistorySegment segment) =>
            Segment is null || Segment == Path.GetFileName(segment.Path) || Segment == RolloutId(segment.Path);

        internal bool Selects(HistoryRow row) =>
            (Turn is null || row.Turn == Turn)
            && (Origin == "all" || Origin == row.Origin)
            && (Since is null && Until is null
                || TryInstant(row.Timestamp, out var time) && (Since is null || time >= Since) && (Until is null || time < Until));
    }

    private readonly record struct Boundary(int Segment, long Line);

    private (Boundary? Start, Boundary? End) WindowBounds(string window)
    {
        int wanted = -1;
        if (window != "current" && !int.TryParse(window, NumberStyles.None, CultureInfo.InvariantCulture, out wanted))
            throw new CliInputException("--window expects a non-negative checkpoint number or current");
        Boundary? preceding = null;
        (Boundary? Start, Boundary? End)? result = null;
        int number = 0;
        for (int i = 0; i < Segments.Count; i++)
        {
            foreach (var row in Scan(Segments[i], number, fingerprint: false, borrow: true))
            {
                if (row.Type != "compacted")
                    continue;
                var checkpoint = new Boundary(i, row.Line);
                number = row.Window;
                if (number == wanted)
                    result = (preceding, checkpoint);
                preceding = checkpoint;
            }
        }
        if (window == "current")
            return (preceding, null);
        return result ?? throw new CliInputException($"no compaction checkpoint for window {window}");
    }

    internal IEnumerable<HistoryRow> Rows(bool scoped = true, bool includeToolBodies = false, Action<HistoryRow>? observe = null,
        bool includeRevision = true)
    {
        Scope? scope = scoped ? Scope.Read(options) : null;
        if (scope?.Segment is { } name && !Segments.Any(scope.Selects))
            throw new CliInputException($"segment is not in the rollout lineage: {name}");

        if (scope is not null && observe is null && (scope.Window is not null || scope.Since is not null
            || scope.Until is not null || scope.First > 1 || scope.Last is not null || options.Has("--cursor")))
        {
            bool build = scope.Window is not null || scope.Since is not null || scope.Until is not null;
            using var index = OpenIndex(build, throughLine: build ? null : scope.Last);
            if (index is not null)
            {
                try
                {
                    foreach (var row in IndexedRows(index, IndexStart(scope), includeRevision))
                        yield return row;
                }
                finally
                {
                    index.Verify();
                }
                yield break;
            }
        }

        var window = scope?.Window is { } selected ? WindowBounds(selected) : (Start: (Boundary?)null, End: (Boundary?)null);
        int number = 0;
        for (int i = 0; i < Segments.Count; i++)
        {
            if (window.End is { } boundary && boundary.Segment < i)
                yield break;
            var segment = Segments[i];
            if (scope is not null && (!scope.Selects(segment) || scope.Origin == "current" && segment.Header.Text("id") != ThreadId))
                continue;
            if (window.Start is { } start && start.Segment > i)
                continue;
            long first = scope?.First ?? 1;
            if (window.Start is { } open && open.Segment == i)
                first = Math.Max(first, open.Line + 1);
            long? last = scope?.Last;
            if (window.End is { } close && close.Segment == i)
                last = Math.Min(last ?? close.Line, close.Line);
            if (first > last)
                continue;

            foreach (var row in Scan(segment, number, fingerprint: includeRevision, last: last, first: first,
                transcriptOnly: scoped && options.Command == "transcript"))
            {
                if (row.Line > last)
                    break;
                if (row.Type == "compacted")
                    number = row.Window;
                observe?.Invoke(row);
                if (row.Line >= first && (scope is null || scope.Selects(row)))
                    yield return row;
                if (row.Line == last)
                    break;
            }
        }
    }

    internal HistoryRow? Find(HistoryRef reference, bool includeToolBodies = true)
        => FindMany([reference]).SingleOrDefault();

    internal IEnumerable<HistoryRow> FindMany(IReadOnlyCollection<HistoryRef> references)
    {
        if (references.Count == 0)
            yield break;
        var bySegment = references.ToLookup(reference => reference.SegmentId, StringComparer.Ordinal);
        foreach (var segment in Segments)
        {
            var targets = bySegment[segment.Id].ToLookup(reference => reference.Line);
            if (targets.Count == 0)
                continue;
            long[] lines = targets.Select(group => group.Key).Order().ToArray();
            using var index = OpenIndex(build: false, throughLine: lines[^1]);
            if (index is null)
            {
                foreach (var row in Scan(segment, 0, last: lines[^1], selectedLines: lines.ToHashSet()))
                {
                    if (targets[row.Line].Any(reference => row.Digest == reference.Digest && row.Offset == reference.Offset))
                        yield return row;
                }
                continue;
            }

            try
            {
                var scope = new Scope(null, null, "all", lines[0], lines[^1], null, null, null);
                foreach (var row in IndexedRows(index, scope, fingerprint: true, exactLines: lines))
                {
                    if (targets[row.Line].Any(reference => row.Digest == reference.Digest && row.Offset == reference.Offset))
                        yield return row;
                }
            }
            finally
            {
                index.Verify();
            }
        }
    }

    internal bool TryTailRows(Func<IEnumerable<HistoryRow>, JsonObject> read, out JsonObject? result)
    {
        using var index = OpenIndex(build: false);
        if (index is null)
        {
            result = null;
            return false;
        }
        Scope scope = Scope.Read(options);
        if (!scope.Selects(Segments[0]))
            throw new CliInputException($"segment is not in the rollout lineage: {scope.Segment}");
        result = read(IndexedRows(index, scope, fingerprint: true, reverse: true));
        index.Verify();
        return true;
    }

    private HistoryIndex? OpenIndex(bool build, long? throughLine = null) =>
        allowIndex && !salvage && Segments.Count == 1
            ? HistoryIndex.TryOpen(options.Home, Segments[0], ScanIndex, build, throughLine)
            : null;

    private Scope IndexStart(Scope scope)
    {
        if (options.Command is not ("search" or "read" or "transcript")
            || options.One("--cursor") is not { } cursor)
            return scope;
        int separator = cursor.LastIndexOf(':');
        if (separator < 0 || !long.TryParse(cursor.AsSpan(separator + 1), NumberStyles.None,
                CultureInfo.InvariantCulture, out long line) || line <= 0
            || !cursor.AsSpan(0, separator).SequenceEqual(Segments[0].Id))
            return scope;
        int preceding = options.Command == "search"
            ? Math.Max(0, options.Integer("--before", 0, minimum: 0, maximum: 20) - 1) : 0;
        return scope with { First = Math.Max(scope.First, line - preceding) };
    }

    private IEnumerable<HistoryIndexedRecord> ScanIndex(FileStream source, long line, long offset, long size, HistoryAnnotation state)
    {
        using var reader = new HistoryLineReader(source);
        reader.Seek(offset);
        foreach (var item in Scan(Segments[0], reader, line, offset, size, state, 0, fingerprint: false, borrow: true))
        {
            var row = item.Row;
            if (row.NextOffset == 0)
                throw new HistoryIndexUnavailable("The rollout has an unterminated final record.");
            long? explicitWindow = HistoryWire.Integer(row.Payload, "window_number");
            yield return new HistoryIndexedRecord(row.Line, row.Offset, row.NextOffset - row.Offset, row.Timestamp,
                row.Type == "compacted", explicitWindow is >= 0 and <= int.MaxValue ? (int)explicitWindow.Value : null, item.Next);
        }
    }

    private IEnumerable<HistoryRow> IndexedRows(HistoryIndex index, Scope scope, bool fingerprint, bool reverse = false,
        long[]? exactLines = null)
    {
        var checkpoints = new List<(long Line, int Number)>();
        int number = 0;
        foreach (var (line, explicitWindow) in index.Checkpoints())
        {
            number = explicitWindow ?? FollowingWindow(number);
            checkpoints.Add((line, number));
        }
        long first = scope.First;
        long? last = scope.Last;
        if (scope.Window == "current" && checkpoints.Count > 0)
            first = Math.Max(first, checkpoints[^1].Line + 1);
        else if (scope.Window is { } window && window != "current")
        {
            if (!int.TryParse(window, NumberStyles.None, CultureInfo.InvariantCulture, out var selected))
                throw new CliInputException("--window expects a non-negative checkpoint number or current");
            int match = checkpoints.FindLastIndex(checkpoint => checkpoint.Number == selected);
            if (match < 0)
                throw new CliInputException($"no compaction checkpoint for window {window}");
            if (match > 0)
                first = Math.Max(first, checkpoints[match - 1].Line + 1);
            last = Math.Min(last ?? checkpoints[match].Line, checkpoints[match].Line);
        }

        var segment = Segments[0];
        using var reader = new HistoryLineReader(index.File);
        var candidates = exactLines is null
            ? index.Rows(first, last, scope.Since, scope.Until, reverse)
            : exactLines.SelectMany(line => index.Rows(line, line, scope.Since, scope.Until));
        foreach (var candidate in candidates)
        {
            reader.Seek(candidate.Offset);
            var raw = reader.ReadLine(candidate.Length);
            if (raw.Length != candidate.Length || raw.IsEmpty || raw.Span[^1] != (byte)'\n'
                || !TryParse(raw, out var decoded, out _) || !HistoryWire.ValidRecord(decoded, salvage: false)
                || HistoryIndex.TimestampMicroseconds(decoded.Text("timestamp")) != candidate.TimestampMicroseconds)
                throw new HistoryIndexUnavailable("An indexed rollout record changed.");
            int checkpoint = checkpoints.BinarySearch((candidate.Line, 0), CheckpointLineComparer);
            int preceding = checkpoint >= 0 ? checkpoint - 1 : ~checkpoint - 1;
            int previous = preceding < 0 ? 0 : checkpoints[preceding].Number;
            var row = Annotate(segment, candidate.Line, candidate.Offset, candidate.Offset + candidate.Length,
                raw, decoded, false, candidate.State, previous, fingerprint).Row;
            if (scope.Selects(row))
                yield return row;
        }
    }

    private static readonly Comparer<(long Line, int Number)> CheckpointLineComparer =
        Comparer<(long Line, int Number)>.Create((left, right) => left.Line.CompareTo(right.Line));

    private IEnumerable<HistoryRow> Scan(HistorySegment segment, int window, bool fingerprint = true, long? last = null,
        bool borrow = false, long first = 1, HashSet<long>? selectedLines = null, bool transcriptOnly = false)
    {
        using var lines = new HistoryLineReader(segment.Path);
        var annotation = new HistoryAnnotation(segment.Header.Text("cwd"), null, false);
        foreach (var item in Scan(segment, lines, 0, 0, segment.EndOffset, annotation, window, fingerprint, last,
            borrow, first, selectedLines, transcriptOnly))
            yield return item.Row;
    }

    private IEnumerable<(HistoryRow Row, HistoryAnnotation Next)> Scan(HistorySegment segment,
        HistoryLineReader reader, long line, long offset, long? stop, HistoryAnnotation state, int previousWindow,
        bool fingerprint, long? last = null, bool borrow = false, long first = 1, HashSet<long>? selectedLines = null,
        bool transcriptOnly = false)
    {
        bool gap = false;
        long? lastOrdinal = null;
        while ((last is null || line < last) && (stop is null || offset < stop))
        {
            var raw = ReadLine(reader, segment.Path, stop is long end ? end - offset : long.MaxValue);
            if (raw.IsEmpty)
                break;
            long start = offset;
            offset += raw.Length;
            line++;

            if (IsBlank(raw.Span))
                continue;
            bool terminated = raw.Span[^1] == (byte)'\n';
            bool selected = line >= first && (selectedLines is null || selectedLines.Contains(line));
            var decoded = Decode(segment.Path, raw, line, start, allowPartial: stop is null, borrow || !selected || transcriptOnly,
                out bool damaged, out JsonDocument? borrowed);
            using var document = borrowed;
            if (damaged)
            {
                gap = true;
                if (!salvage)
                    break;
                continue;
            }
            if (segment.EndOrdinal is long limit)
            {
                lastOrdinal = HistoryWire.Integer(decoded, "ordinal");
                if (!terminated || lastOrdinal is null || lastOrdinal >= limit)
                    throw new RolloutReadException("history_base cutoff crosses a record", segment.Path, line);
            }
            var item = Annotate(segment, line, start, terminated ? offset : 0, raw, decoded, gap, state, previousWindow,
                fingerprint && selected && !transcriptOnly);
            var row = item.Row;
            if (row.Type == "compacted")
                previousWindow = row.Window;
            state = item.Next;
            gap = false;
            if (selectedLines is not null && !selected || transcriptOnly && !TranscriptCandidate(row))
                continue;
            if (selected && !borrow && borrowed is not null)
                row = row with { Value = decoded.Clone(), Digest = fingerprint ? Fingerprint(raw.Span, row.Cwd) : "" };
            yield return (row, state);
        }
        if ((last is null || line < last) && segment.EndOrdinal is long ordinal
            && (gap || offset != stop || lastOrdinal != ordinal - 1))
            throw new RolloutReadException("history_base cutoff does not match the rollout", segment.Path, 0);
    }

    private bool TranscriptCandidate(HistoryRow row)
    {
        string type = row.Type;
        if (type == "response_item" && row.ItemType == "message")
            return true;
        if (type == "realtime_item" && RecordProjection.VoiceTranscript(row.Payload) is not null)
            return true;
        if (type == "event_msg")
        {
            string? eventType = row.ItemType;
            if (eventType == "agent_message" && row.Payload.Text("delivery") == "async")
                return true;
            var item = row.Payload.Get("item");
            if (eventType == "item_completed" && item.Text("type") == "AgentMessage"
                && item.Text("delivery") == "async")
                return true;
        }
        return options.One("--cursor") is { } cursor && row.Cursor == cursor;
    }

    private static bool IsBlank(ReadOnlySpan<byte> raw)
    {
        foreach (byte value in raw)
        {
            if (value is not (9 or 10 or 11 or 12 or 13 or 32))
                return false;
        }
        return true;
    }

    private static ReadOnlyMemory<byte> ReadLine(HistoryLineReader reader, string path, long limit)
    {
        try
        {
            return reader.ReadLine(limit);
        }
        catch (ZstdException error)
        {
            throw new RolloutReadException($"cannot decompress Zstandard rollout ({error.Message})", path, 0);
        }
        catch (EndOfStreamException) when (HistoryLineReader.IsCompressed(path))
        {
            throw new RolloutReadException("cannot decompress Zstandard rollout (truncated Zstandard frame)", path, 0);
        }
    }

    private static bool TryParse(ReadOnlyMemory<byte> raw, out JsonElement row, out string reason) =>
        TryParse(raw, borrow: false, out row, out reason, out _);

    private static bool TryParse(ReadOnlyMemory<byte> raw, bool borrow, out JsonElement row, out string reason,
        out JsonDocument? borrowed)
    {
        borrowed = null;
        try
        {
            if (borrow)
            {
                borrowed = HistoryWire.Borrow(raw);
                row = borrowed.RootElement;
            }
            else
            {
                row = HistoryWire.Parse(raw.Span);
            }
            reason = "";
            return true;
        }
        catch (DecoderFallbackException)
        {
            reason = "invalid Unicode encoding";
        }
        catch (JsonException error)
        {
            reason = error.Message.Contains("maximum configured depth", StringComparison.Ordinal)
                ? "nesting is too deep"
                : $"column {(error.BytePositionInLine ?? 0) + 1}: {error.Message}";
        }
        row = default;
        return false;
    }

    private JsonElement Decode(string path, ReadOnlyMemory<byte> raw, long line, long offset, bool allowPartial,
        bool borrow, out bool damaged, out JsonDocument? borrowed)
    {
        damaged = false;
        bool parsed = TryParse(raw, borrow, out var row, out string reason, out borrowed);
        if (parsed && HistoryWire.ValidRecord(row, salvage))
            return row;

        bool partial = !parsed && allowPartial && raw.Span[^1] != (byte)'\n';
        if (!salvage && !partial)
        {
            borrowed?.Dispose();
            throw new RolloutReadException(parsed ? "invalid JSONL record structure" : $"invalid JSONL ({reason})", path, line);
        }

        damage[(path, line)] = new JsonObject
        {
            ["path"] = path,
            ["line"] = line,
            ["byte_offset"] = offset,
            ["reason"] = parsed ? "invalid_record" : partial ? "partial_tail" : "invalid_json",
        };
        damaged = true;
        return default;
    }

    private (HistoryRow Row, HistoryAnnotation Next) Annotate(HistorySegment segment, long line, long offset, long next,
        ReadOnlyMemory<byte> raw, JsonElement value, bool gap, HistoryAnnotation state, int previousWindow, bool fingerprint)
    {
        string? owner = segment.Header.Text("id");
        string type = value.Text("type")!;
        var payload = value.Get("payload");
        string? eventType = type == "event_msg" ? payload.Text("type") : null;
        (bool copied, bool unknown) = CopiedOrigin(segment, line, value, type);
        string? cwd = state.Cwd;
        string? activeTurn = state.ActiveTurn;
        if (copied != state.InPrefix)
        {
            cwd = copied ? null : segment.Header.Text("cwd");
            activeTurn = null;
        }
        if (gap)
            cwd = activeTurn = null;
        if (type is "session_meta" or "turn_context" && payload.Text("cwd") is { Length: > 0 } workingDirectory)
            cwd = workingDirectory;
        if (eventType is not null && TurnStart.Contains(eventType))
            activeTurn = payload.Text("turn_id");
        string? turn = payload.Text("turn_id") ?? (eventType == "thread_goal_updated" ? payload.Text("turnId") : null);
        if (string.IsNullOrEmpty(turn))
        {
            turn = payload.Get("internal_chat_message_metadata_passthrough").Text("turn_id");
            if (string.IsNullOrEmpty(turn))
                turn = activeTurn;
        }
        if (eventType is not null && TurnEnd.Contains(eventType) && turn == activeTurn)
            activeTurn = null;

        string origin = copied || owner != ThreadId ? "inherited" : unknown ? "unknown" : "current";
        int window = type == "compacted" ? CheckpointWindow(previousWindow, payload) : FollowingWindow(previousWindow);
        return (new HistoryRow(segment, line, offset, value, fingerprint ? Fingerprint(raw.Span, cwd) : "", window,
            turn, cwd, origin, owner, next, gap, copied), new HistoryAnnotation(cwd, activeTurn, copied));
    }

    internal static (bool Copied, bool Unknown) CopiedOrigin(HistorySegment segment, long line, JsonElement value, string type)
    {
        if (line == 1 && type == "session_meta")
            return (false, false);
        if (HistoryWire.Integer(segment.Header, "subagent_history_start_ordinal") is > 0 and long start)
            return HistoryWire.Integer(value, "ordinal") is long ordinal ? (ordinal < start, false) : (false, true);
        if (segment.Header.Text("forked_from_id") is { Length: > 0 } && !HistoryWire.Truthy(segment.Header.Get("history_base")))
            return HistoryWire.Truthy(value.Get("metadata").Get("inherited_user_message")) ? (true, false) : (false, true);
        return (false, false);
    }

    private static string Fingerprint(ReadOnlySpan<byte> raw, string? cwd)
    {
        if (raw.EndsWith("\n"u8))
            raw = raw[..^1];
        if (raw.EndsWith("\r"u8))
            raw = raw[..^1];
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(raw, hash);
        if (cwd is not null)
        {
            int length = Encoding.UTF8.GetByteCount(cwd);
            Span<byte> combined = length <= 512 ? stackalloc byte[32 + length] : new byte[32 + length];
            hash.CopyTo(combined);
            Encoding.UTF8.GetBytes(cwd, combined[32..]);
            SHA256.HashData(combined, hash);
        }
        return Convert.ToHexStringLower(hash[..12]);
    }
}
