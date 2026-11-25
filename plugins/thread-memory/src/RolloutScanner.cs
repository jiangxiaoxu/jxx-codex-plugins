using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ThreadMemoryHook;

internal sealed record RolloutSnapshot(string? Window, long? Used, long? Capacity, HashSet<int> ReceivedLevels,
    string? Checkpoint, List<ReminderReceipt> Receipts, List<CompactionObservation> Compactions,
    IReadOnlyList<StoredCheckpoint> Aliases, IReadOnlyList<string> EquivalentWindows);

internal static partial class RolloutScanner
{
    public const int BlockBytes = 1024 * 1024;
    public const int ScanBytes = 512 * BlockBytes;
    private const int RecordBytes = 256 * 1024;
    private const int PrefixBytes = 512;
    private const int TrailerBytes = 8;
    private const string ReminderOpen = "<thread_memory_reminder>\n";
    private const string ReminderClose = "\n</thread_memory_reminder>";
    private const string ReminderLevels = @"(?:100|[1-9][0-9]?|0)(?:,(?:100|[1-9][0-9]?|0)){0,100}";

    private sealed record Header(long End, UInt128? FirstOwned, string Segment, string? ThreadId, bool CopiedWithoutBoundary);
    private readonly record struct Line(long? Offset, ReadOnlyMemory<byte> Raw, ReadOnlyMemory<byte> Trailer, bool Clipped);
    private readonly record struct Envelope(string Kind, UInt128? Ordinal, int PayloadOffset, string? Timestamp);

    private sealed class Usage(long used, long? capacity, string? turn = null)
    {
        public long Used { get; } = used;
        public long? Capacity { get; set; } = capacity;
        public string? Turn { get; } = turn;
        public string? Model { get; set; }

        public bool Matches(string? model, long? capacity) =>
            (Model is null || Model == model) && (Capacity is null || capacity is null || Capacity == capacity);
    }

    private sealed class Capture
    {
        public long? Boundary;
        public List<byte[]> Signals = [];
        public TurnCoverage Coverage = new();
        public List<ReminderReceipt> Receipts { get; } = [];
        public List<CompactionObservation> Compactions { get; } = [];
        public Dictionary<string, HashSet<int>> ActiveReceipts { get; } = [];

        public void LinkPrevious(string window)
        {
            if (Compactions.Count != 0 && Compactions[^1].PreviousWindow is null)
                Compactions[^1] = Compactions[^1] with { PreviousWindow = window };
        }
    }

    public static string ReminderWindowId(string window) => Convert.ToBase64String(
        Blake2s.Hash(Encoding.ASCII.GetBytes(window), 6)).Replace('+', '-').Replace('/', '_');

    public static RolloutSnapshot Scan(FileStream stream, RolloutPath file, string? canonicalCheckpoint,
        Func<IReadOnlyList<StoredCheckpoint>> loadAliases, long minimumUsed, string? expectedTurn, string? expectedModel,
        int scanBytes)
    {
        if (Path.GetExtension(file.Name) == ".zst")
            return Empty();
        scanBytes = Math.Min(scanBytes, ScanBytes);
        try
        {
            stream.Position = 0;
            var stat = file.Stat;
            using var rawHeader = RolloutHeader.Read(stream, requireTerminator: true);
            if (rawHeader is null || rawHeader.Length > stat.Length)
                return Empty();
            var payload = rawHeader.Payload;
            var firstOwned = Ordinal(Property(payload, "subagent_history_start_ordinal"u8));
            var copiedWithoutBoundary = firstOwned.GetValueOrDefault() == 0 &&
                Truthy(Property(payload, "forked_from_id"u8)) && !Truthy(Property(payload, "history_base"u8));
            var segments = new Dictionary<string, string>(StringComparer.Ordinal);
            string Segment(string name)
            {
                if (!segments.TryGetValue(name, out var segment))
                    segments.Add(name, segment = rawHeader.Segment(name));
                return segment;
            }
            var header = new Header(rawHeader.Length, firstOwned.GetValueOrDefault() > 0 ? firstOwned : null,
                Segment(file.Name), String(Property(payload, "id"u8)), copiedWithoutBoundary);

            ReminderCheckpoint? ReadCheckpoint(string? raw) =>
                RolloutCursor.ReadCheckpoint(file, stream, Segment, header.End, raw, ScanBytes);
            var canonical = ReadCheckpoint(canonicalCheckpoint);
            var verifiedAliases = new List<(StoredCheckpoint Stored, ReminderCheckpoint Checkpoint)>();
            ReminderCheckpoint? prior = null;
            ReminderCheckpoint? continuity = canonical;
            var capture = new Capture();
            (string? Window, long? Used, long? Capacity, HashSet<int>? Received) state = default;
            bool Replay(ReminderCheckpoint? candidate)
            {
                if (candidate is null || stat.Length - candidate.Offset > scanBytes)
                    return false;
                try
                {
                    state = ScanCore(stream, header, stat.Length, minimumUsed, expectedTurn, expectedModel, scanBytes, candidate, candidate, capture);
                    prior = candidate;
                    continuity = candidate;
                    return true;
                }
                catch (Exception error) when (IsScanError(error))
                {
                    capture = new Capture();
                    return false;
                }
            }
            bool replayed;
            if (canonical is { Normalized: true } && Replay(canonical))
                replayed = true;
            else
            {
                foreach (var stored in loadAliases())
                    if (!string.Equals(stored.Path, file.Key, StringComparison.Ordinal) && ReadCheckpoint(stored.Raw) is { } verified)
                        verifiedAliases.Add((stored, verified));
                var newest = verifiedAliases.OrderByDescending(alias => alias.Checkpoint.Offset)
                    .ThenBy(alias => alias.Stored.Path, StringComparer.Ordinal).FirstOrDefault().Checkpoint;
                continuity ??= newest;
                replayed = canonical is { Normalized: false } && Replay(canonical) || Replay(newest);
            }
            if (!replayed)
                state = ScanCore(stream, header, stat.Length, minimumUsed, expectedTurn, expectedModel, scanBytes, null, continuity, capture);

            var after = RolloutFileStat.Capture(stream);
            if (after.Length < stat.Length || (after.Length == stat.Length && after.ModifiedNanoseconds != stat.ModifiedNanoseconds))
                return Empty();
            var retained = ReferenceEquals(prior, canonical) && prior is not null ? canonicalCheckpoint : null;
            var received = state.Received ?? [];
            var aliasesToRemove = new List<StoredCheckpoint>();
            var equivalentWindows = new List<RolloutWindowAlias>();
            if (state.Window is { } window && capture.Boundary is long boundary)
            {
                var sameBoundary = new HashSet<string>(StringComparer.Ordinal) { window };
                var fingerprintPath = continuity?.Window == window ? continuity.FingerprintPath : file.Key;
                void AddEquivalent(RolloutWindowAlias alias)
                {
                    if (!sameBoundary.Add(alias.Window))
                        return;
                    equivalentWindows.Add(alias);
                    if (capture.ActiveReceipts.TryGetValue(ReminderWindowId(alias.Window), out var levels))
                        received.UnionWith(levels);
                }
                void Merge(ReminderCheckpoint candidate)
                {
                    // The same suffix binds start or the same offset and boundary bytes.
                    if (!MatchesWindow(candidate, window, boundary))
                        return;
                    received.UnionWith(candidate.Receipts);
                    AddEquivalent(new(candidate.FingerprintPath, candidate.Window));
                    foreach (var alias in candidate.EquivalentWindows)
                        AddEquivalent(alias);
                }
                if (prior is not null)
                    Merge(prior);
                if (canonical is not null && !ReferenceEquals(prior, canonical))
                    Merge(canonical);
                foreach (var (_, verified) in verifiedAliases)
                    if (!ReferenceEquals(prior, verified))
                        Merge(verified);

                AddEquivalent(new(file.Key, header.Segment + window[24..]));
                if (prior?.Offset != stat.Length || retained is null || prior is { Normalized: false } || verifiedAliases.Count != 0)
                {
                    var next = RolloutCursor.WriteCheckpoint(file, stream, fingerprintPath,
                        window[..24], boundary, window, received, capture.Signals, capture.Coverage, equivalentWindows);
                    if (next is not null)
                    {
                        retained = next;
                        aliasesToRemove.AddRange(verifiedAliases.Select(alias => alias.Stored));
                    }
                }
            }
            capture.Receipts.Reverse();
            capture.Compactions.Reverse();
            return new(state.Window, state.Used, state.Capacity, received, retained, capture.Receipts, capture.Compactions,
                aliasesToRemove, equivalentWindows.Select(alias => alias.Window).ToArray());
        }
        catch (Exception error) when (IsScanError(error))
        {
            return Empty();
        }
    }

    private static RolloutSnapshot Empty() => new(null, null, null, [], null, [], [], [], []);

    private static bool IsScanError(Exception error) => error is IOException or UnauthorizedAccessException
        or JsonException or FormatException or InvalidOperationException or ArgumentException;

    private static IEnumerable<Line> ReverseLines(FileStream stream, long size, long lower, bool knownLineStart)
    {
        var block = ArrayPool<byte>.Shared.Rent(BlockBytes);
        var pending = ArrayPool<byte>.Shared.Rent(RecordBytes);
        var trailer = new byte[TrailerBytes];
        var prefixLength = 0;
        var trailerLength = 0;
        var cursor = size;
        var lineEnd = size;
        try
        {
            while (cursor > lower)
            {
                var start = Math.Max(lower, cursor - BlockBytes);
                var end = (int)(cursor - start);
                stream.Position = start;
                stream.ReadExactly(block.AsSpan(0, end));
                cursor = start;
                while (true)
                {
                    var newline = block.AsSpan(0, end).LastIndexOf((byte)'\n');
                    var part = block.AsMemory(newline + 1, end - newline - 1);
                    var offset = start + newline + 1;
                    var clipped = lineEnd - offset > RecordBytes;
                    if (newline < 0 || prefixLength != 0)
                    {
                        var prefixPart = Math.Min(part.Length, clipped ? PrefixBytes : RecordBytes);
                        prefixLength = Math.Min(prefixLength, (clipped ? PrefixBytes : RecordBytes) - prefixPart);
                        pending.AsSpan(0, prefixLength).CopyTo(pending.AsSpan(prefixPart));
                        part.Span[..prefixPart].CopyTo(pending);
                        prefixLength += prefixPart;
                        var trailerPart = Math.Min(part.Length, TrailerBytes - trailerLength);
                        trailer.AsSpan(0, trailerLength).CopyTo(trailer.AsSpan(trailerPart));
                        part.Span[^trailerPart..].CopyTo(trailer);
                        trailerLength += trailerPart;
                        if (newline < 0)
                            break;
                        if (lineEnd != size)
                            yield return new(offset, pending.AsMemory(0, prefixLength), trailer.AsMemory(0, trailerLength), clipped);
                    }
                    else if (lineEnd != size)
                    {
                        yield return new(offset, clipped ? part[..PrefixBytes] : part, part[^Math.Min(TrailerBytes, part.Length)..], clipped);
                    }
                    end = newline;
                    lineEnd = start + end;
                    prefixLength = trailerLength = 0;
                }
            }
            if (knownLineStart && lower < lineEnd && lineEnd < size)
                yield return new(lower, pending.AsMemory(0, prefixLength), trailer.AsMemory(0, trailerLength), lineEnd - lower > RecordBytes);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(block);
            ArrayPool<byte>.Shared.Return(pending);
        }
    }

    private static JsonDocument Parse(ReadOnlyMemory<byte> raw) => JsonDocument.Parse(
        raw.Span.StartsWith(new byte[] { 0xEF, 0xBB, 0xBF }) ? raw[3..] : raw,
        new JsonDocumentOptions { MaxDepth = 1_000 });

    private static JsonElement Property(JsonElement element, ReadOnlySpan<byte> name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : default;

    private static bool StringEquals(JsonElement element, ReadOnlySpan<byte> value) =>
        element.ValueKind == JsonValueKind.String && element.ValueEquals(value);

    private static string? String(JsonElement element) => element.ValueKind == JsonValueKind.String ? element.GetString() : null;

    private static long? Integer(JsonElement element) =>
        element.ValueKind == JsonValueKind.Number && element.TryGetInt64(out var value) ? value : null;

    private static long? Positive(JsonElement element) => Integer(element) is > 0 and long value ? value : null;

    private static UInt128? Ordinal(JsonElement element) =>
        element.ValueKind == JsonValueKind.Number && UInt128.TryParse(element.GetRawText(), NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            ? value : null;

    private static bool Truthy(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.False => false,
        JsonValueKind.String => element.GetString()!.Length != 0,
        JsonValueKind.Array => element.GetArrayLength() != 0,
        JsonValueKind.Object => element.EnumerateObject().MoveNext(),
        JsonValueKind.Number => element.GetDouble() != 0,
        _ => true,
    };

    private static bool AsciiKind(ReadOnlySpan<byte> text)
    {
        foreach (var value in text)
            if (value is not ((>= (byte)'a' and <= (byte)'z') or (byte)'_'))
                return false;
        return !text.IsEmpty;
    }

    private static bool PropertyIs(ref Utf8JsonReader reader, ReadOnlySpan<byte> name) =>
        reader.TokenType == JsonTokenType.PropertyName && !reader.ValueIsEscaped && reader.ValueSpan.SequenceEqual(name);

    private static Envelope? ReadEnvelope(ReadOnlySpan<byte> raw)
    {
        var reader = new Utf8JsonReader(raw, isFinalBlock: false, state: default);
        try
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject || !reader.Read())
                return null;
            ReadOnlySpan<byte> timestamp = default;
            var hasTimestamp = false;
            if (PropertyIs(ref reader, "timestamp"u8))
            {
                if (!reader.Read() || reader.TokenType != JsonTokenType.String || reader.ValueIsEscaped || reader.ValueSpan.Length > 64)
                    return null;
                timestamp = reader.ValueSpan;
                hasTimestamp = true;
                if (!reader.Read())
                    return null;
            }
            UInt128? ordinal = null;
            if (PropertyIs(ref reader, "ordinal"u8))
            {
                if (!reader.Read() || reader.TokenType != JsonTokenType.Number || reader.ValueSpan.Length > 20 ||
                    !UInt128.TryParse(reader.ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || !reader.Read())
                    return null;
                ordinal = parsed;
            }
            if (!PropertyIs(ref reader, "type"u8) || !reader.Read() || reader.TokenType != JsonTokenType.String ||
                !AsciiKind(reader.ValueSpan))
                return null;
            var kind = reader.ValueSpan switch
            {
                var value when value.SequenceEqual("compacted"u8) => "compacted",
                var value when value.SequenceEqual("session_meta"u8) => "session_meta",
                var value when value.SequenceEqual("response_item"u8) => "response_item",
                var value when value.SequenceEqual("event_msg"u8) => "event_msg",
                var value when value.SequenceEqual("token_usage_record"u8) => "token_usage_record",
                var value when value.SequenceEqual("turn_context"u8) => "turn_context",
                _ => "",
            };
            if (!reader.Read() || !PropertyIs(ref reader, "payload"u8) || !reader.Read() || reader.TokenType != JsonTokenType.StartObject)
                return null;
            return new(kind, ordinal, (int)reader.TokenStartIndex,
                kind == "compacted" && hasTimestamp && Ascii.IsValid(timestamp) ? Encoding.ASCII.GetString(timestamp) : null);
        }
        catch (JsonException) { return null; }
    }

    private static bool IgnoreEvent(ReadOnlySpan<byte> raw)
    {
        var reader = new Utf8JsonReader(raw, isFinalBlock: false, state: default);
        try
        {
            if (!reader.Read() || !reader.Read() || !PropertyIs(ref reader, "type"u8) || !reader.Read() ||
                reader.TokenType != JsonTokenType.String || !AsciiKind(reader.ValueSpan))
                return false;
            var subtype = reader.ValueSpan;
            var after = TrimStart(raw[(int)reader.BytesConsumed..]);
            return !after.IsEmpty && (after[0] is (byte)',' or (byte)'}') &&
                !subtype.SequenceEqual("task_started"u8) && !subtype.SequenceEqual("turn_started"u8) &&
                !subtype.SequenceEqual("token_count"u8) && !subtype.SequenceEqual("thread_settings_applied"u8) &&
                !subtype.SequenceEqual("thread_rolled_back"u8);
        }
        catch (JsonException) { return false; }
    }

    private static bool IsSpace(byte value) => value is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n' or 11 or 12;

    private static ReadOnlySpan<byte> TrimStart(ReadOnlySpan<byte> raw)
    {
        var start = 0;
        while (start < raw.Length && IsSpace(raw[start]))
            start++;
        return raw[start..];
    }

    private static ReadOnlySpan<byte> TrimEnd(ReadOnlySpan<byte> raw)
    {
        var end = raw.Length;
        while (end > 0 && IsSpace(raw[end - 1]))
            end--;
        return raw[..end];
    }

    private static string? Timestamp(JsonElement value)
    {
        var text = String(value);
        return text is { Length: <= 64 } && Ascii.IsValid(text) ? text : null;
    }

    private static JsonDocument? ReadRecord(Line line, Envelope? envelope, out string kind, out UInt128? ordinal)
    {
        if (envelope is Envelope header)
        {
            (kind, ordinal) = (header.Kind, header.Ordinal);
            if (kind == "compacted" && line.Clipped && TrimEnd(line.Trailer.Span).EndsWith("}}"u8) ||
                kind == "event_msg" && IgnoreEvent(line.Raw.Span[header.PayloadOffset..]) ||
                kind is not ("event_msg" or "compacted" or "session_meta" or "turn_context" or "token_usage_record"))
                return null;
        }
        if (line.Clipped)
            throw new FormatException("Cannot classify a large rollout record.");
        var record = Parse(line.Raw);
        try
        {
            kind = String(Property(record.RootElement, "type"u8)) ?? throw new FormatException("Invalid rollout record.");
            if (Property(record.RootElement, "payload"u8).ValueKind != JsonValueKind.Object)
                throw new FormatException("Invalid rollout payload.");
            ordinal = Ordinal(Property(record.RootElement, "ordinal"u8));
            return record;
        }
        catch
        {
            record.Dispose();
            throw;
        }
    }

    private static IEnumerable<Line> ScanLines(FileStream stream, long size, long lower, bool atStart, ReminderCheckpoint? prior)
    {
        foreach (var line in ReverseLines(stream, size, lower, atStart || prior is not null))
            yield return line;
        if (prior is not null)
        {
            foreach (var raw in prior.Signals)
                yield return new(null, raw, default, false);
            yield return default;
        }
    }

    private static (string? Window, long? Used, long? Capacity, HashSet<int>? Received) ScanCore(
        FileStream stream, Header header, long size, long minimumUsed, string? expectedTurn, string? expectedModel,
        int scanBytes, ReminderCheckpoint? prior, ReminderCheckpoint? continuity, Capture capture)
    {
        var lower = prior?.Offset ?? Math.Max(header.End, size - scanBytes);
        var atStart = lower == header.End;
        var start = $"{header.Segment}:start";
        string VerifiedWindow(string window, long boundary) =>
            continuity is not null && MatchesWindow(continuity, window, boundary) ? continuity.Window : window;
        string? current = null;
        Usage? native = null, response = null;
        long? latestCapacity = null;
        string? latestTurn = null, latestModel = null, effectiveModel = null;
        var turnCapacities = new Dictionary<string, (long Capacity, int Order)>();
        var receipts = capture.ActiveReceipts;
        int? replayStart = null;
        long? boundary = atStart ? header.End : null;
        var signals = new SortedDictionary<int, byte[]>();
        var coverage = new TurnCoverage();
        var hasTurnlessModel = false;
        var hasSettingsModel = false;
        int? latestTurnModelAt = null;
        var omittedTurnModels = false;
        var needsOwnedBoundary = header.CopiedWithoutBoundary && prior is null;
        var belowMinimum = false;
        var order = -1;
        var exhausted = true;
        foreach (var line in ScanLines(stream, size, lower, atStart, prior))
        {
            order++;
            var evidenceOnly = belowMinimum || current is not null;
            // The normal probe stops at the active boundary. Drain a short physical suffix for diagnostics.
            var canDrain = line.Offset is long offsetInFile && offsetInFile - lower <= BlockBytes;
            if (line.Offset is null)
            {
                capture.LinkPrevious(prior!.Window);
                if (evidenceOnly)
                {
                    exhausted = false;
                    break;
                }
                if (replayStart is null)
                {
                    replayStart = order;
                    coverage = prior.TurnCoverage;
                    if (latestTurn is not null && effectiveModel is null && coverage.MayHideModel(latestTurn) ||
                        response?.Turn is string responseTurn && (response.Model is null && coverage.MayHideModel(responseTurn) ||
                            response.Capacity is null && !turnCapacities.ContainsKey(responseTurn) && coverage.MayHideCapacity(responseTurn)))
                        throw new FormatException("Checkpoint lacks turn evidence for appended records.");
                }
                if (line.Raw.IsEmpty)
                {
                    exhausted = false;
                    break;
                }
            }
            if (TrimStart(line.Raw.Span).IsEmpty)
                continue;

            var envelope = ReadEnvelope(line.Raw.Span);
            string kind;
            UInt128? ordinal;
            JsonDocument? record;
            try { record = ReadRecord(line, envelope, out kind, out ordinal); }
            catch (Exception error) when (evidenceOnly && IsScanError(error))
            {
                exhausted = false;
                break;
            }
            using (record)
            {
                var firstOwnedRecord = false;
                if (line.Offset is long ownedOffset && header.FirstOwned is UInt128 firstOwned)
                {
                    if (ordinal is null)
                    {
                        if (evidenceOnly)
                        {
                            exhausted = false;
                            break;
                        }
                        capture.Receipts.Clear();
                        capture.Compactions.Clear();
                        return default;
                    }
                    if (ordinal < firstOwned)
                    {
                        atStart = true;
                        capture.LinkPrevious(VerifiedWindow(start, ownedOffset));
                        if (current is null)
                            boundary = ownedOffset;
                        exhausted = false;
                        break;
                    }
                    firstOwnedRecord = ordinal == firstOwned;
                    atStart |= firstOwnedRecord;
                    if (firstOwnedRecord && current is null)
                        boundary = ownedOffset;
                }
                var payload = record is null ? default : Property(record.RootElement, "payload"u8);
                var eventValue = kind == "event_msg" ? Property(payload, "type"u8) : default;
                if (eventValue.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null or JsonValueKind.String))
                {
                    if (!evidenceOnly)
                        throw new FormatException("Invalid rollout event.");
                    exhausted = false;
                    break;
                }
                var eventName = String(eventValue);
                // Codex writes settings for the fork's own thread after the copied prefix.
                // Only a settings row older than the candidate can prove its ownership.
                if (needsOwnedBoundary && current is not null && eventName == "thread_settings_applied" &&
                    header.ThreadId is string thread && String(Property(payload, "thread_id"u8)) == thread)
                {
                    needsOwnedBoundary = false;
                    exhausted = false;
                    break;
                }
                if (line.Offset is null && kind is not ("turn_context" or "token_usage_record") &&
                    eventName is not ("task_started" or "turn_started" or "token_count" or "thread_settings_applied"))
                    throw new FormatException("Invalid checkpoint signal.");
                if ((kind == "compacted" || eventName == "thread_rolled_back") && line.Offset is long compactOffset)
                {
                    var fingerprint = Convert.ToHexStringLower(Blake2s.Hash(line.Raw.Span, line.Trailer.Span, 8));
                    var key = VerifiedWindow($"{header.Segment}:{compactOffset.ToString(CultureInfo.InvariantCulture)}:{fingerprint}", compactOffset);
                    capture.LinkPrevious(key);
                    if (kind == "compacted")
                    {
                        var timestamp = envelope is Envelope matched ? matched.Timestamp
                            : record is null ? null : Timestamp(Property(record.RootElement, "timestamp"u8));
                        capture.Compactions.Add(new(key, timestamp, null));
                    }
                    if (!evidenceOnly)
                    {
                        current = key;
                        boundary = compactOffset;
                        if (needsOwnedBoundary && continuity is not null &&
                            (compactOffset >= continuity.Offset || MatchesWindow(continuity, key, compactOffset)))
                            needsOwnedBoundary = false;
                        if (!needsOwnedBoundary && (!canDrain || (header.CopiedWithoutBoundary && prior is null)))
                        {
                            exhausted = false;
                            break;
                        }
                    }
                }
                if (kind == "response_item" && line.Offset is long receiptOffset && !line.Clipped)
                    ScanReceipts(line.Raw, receiptOffset, ordinal, current is null && !belowMinimum ? receipts : null, capture);

                if (current is not null || belowMinimum)
                {
                    if (firstOwnedRecord)
                    {
                        capture.LinkPrevious(VerifiedWindow(start, line.Offset!.Value));
                        exhausted = false;
                        break;
                    }
                    continue;
                }

                byte[]? signal = null;
                if (kind == "token_usage_record" && response is null && native is null)
                {
                    response = Sample(payload, perResponse: true);
                    if (response is not null)
                        signal = UsageSignal(response, perResponse: true);
                }
                else if (eventName == "token_count" && native is null)
                {
                    native = Sample(payload, perResponse: false);
                    if (native is not null && native.Used < minimumUsed && (response is null || response.Used < minimumUsed))
                    {
                        belowMinimum = true;
                        if (prior is null || !canDrain || firstOwnedRecord)
                        {
                            exhausted = false;
                            break;
                        }
                        continue;
                    }
                    if (native is not null)
                        signal = UsageSignal(native, perResponse: false);
                }
                else if (eventName is "task_started" or "turn_started")
                {
                    var capacity = Positive(Property(payload, "model_context_window"u8));
                    var turn = String(Property(payload, "turn_id"u8));
                    var keep = capacity is not null && latestCapacity is null;
                    latestCapacity ??= capacity;
                    if (native is not null && native.Capacity is null && capacity is not null)
                    {
                        native.Capacity = capacity;
                        keep = true;
                    }
                    if (!string.IsNullOrEmpty(turn))
                    {
                        if (latestTurn is null)
                        {
                            latestTurn = turn;
                            keep = true;
                        }
                        if (capacity is long turnCapacity)
                            turnCapacities.TryAdd(turn, (turnCapacity, order));
                    }
                    if (keep)
                        signal = StartSignal(eventName, turn, capacity);
                }
                else if (kind == "turn_context")
                {
                    var turnElement = Property(payload, "turn_id"u8);
                    var nullTurn = turnElement.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null;
                    var turn = String(turnElement);
                    var keep = !string.IsNullOrEmpty(turn) && latestTurn is null;
                    if (keep)
                        latestTurn = turn;
                    var model = String(Property(payload, "model"u8));
                    if (!string.IsNullOrEmpty(model))
                    {
                        keep |= latestModel is null;
                        latestModel ??= model;
                        if (nullTurn || (turn is not null && turn == latestTurn))
                        {
                            keep |= effectiveModel is null;
                            effectiveModel ??= model;
                        }
                        if (nullTurn && !hasTurnlessModel)
                            keep = hasTurnlessModel = true;
                        else if (turn is not null && turn != latestTurn)
                            omittedTurnModels = true;
                        else if (turn is not null && latestTurnModelAt is null)
                        {
                            keep = true;
                            latestTurnModelAt = order;
                        }
                        keep |= AssignModel(native, model, turn) | AssignModel(response, model, turn);
                    }
                    if (keep)
                        signal = ContextSignal(turn, nullTurn, model);
                }
                else if (eventName == "thread_settings_applied")
                {
                    var settingsThread = Property(payload, "thread_id"u8);
                    var settings = Property(payload, "thread_settings"u8);
                    var model = String(Property(settings, "model"u8));
                    if (!string.IsNullOrEmpty(model) && (settingsThread.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null ||
                        settingsThread.ValueKind == JsonValueKind.String && String(settingsThread) == header.ThreadId))
                    {
                        var keep = !hasSettingsModel || effectiveModel is null;
                        hasSettingsModel = true;
                        effectiveModel ??= model;
                        keep |= AssignModel(native, model, global: true) | AssignModel(response, model, global: true);
                        if (keep)
                            signal = SettingsSignal(model);
                    }
                }
                if (signal is not null)
                    signals[order] = signal;
                if (firstOwnedRecord)
                {
                    capture.LinkPrevious(VerifiedWindow(start, line.Offset!.Value));
                    exhausted = false;
                    break;
                }
            }
        }
        if (exhausted && atStart)
            capture.LinkPrevious(VerifiedWindow(start, header.End));
        if (needsOwnedBoundary)
        {
            capture.Receipts.Clear();
            capture.Compactions.Clear();
            return default;
        }
        if (belowMinimum)
            return default;
        var markedTurn = latestTurn;
        latestTurn ??= response?.Turn;
        if (!string.IsNullOrEmpty(expectedTurn) && !string.IsNullOrEmpty(latestTurn) && expectedTurn != latestTurn ||
            !string.IsNullOrEmpty(expectedModel) && !string.IsNullOrEmpty(effectiveModel) && expectedModel != effectiveModel)
            return default;

        if (current is null)
        {
            if (replayStart is not null && prior is not null)
            {
                current = prior.Window;
                boundary = prior.Boundary;
                GetLevels(receipts, ReminderWindowId(current)).UnionWith(prior.Receipts);
            }
            else if (atStart)
                current = VerifiedWindow(start, boundary ?? header.End);
            else
                return default; // A bounded tail alone cannot prove a boundary in the omitted prefix.
        }
        foreach (var turn in new[] { markedTurn, response?.Turn })
        {
            if (turn is not null && turnCapacities.TryGetValue(turn, out var retained) && !signals.ContainsKey(retained.Order))
                signals.Add(retained.Order, StartSignal("task_started", turn, retained.Capacity));
        }
        int? capacityAt = markedTurn is not null && turnCapacities.TryGetValue(markedTurn, out var markedCapacity) ? markedCapacity.Order : null;
        var modelKnown = markedTurn is not null && (!coverage.MayHideModel(markedTurn) || latestTurnModelAt < replayStart);
        var capacityKnown = markedTurn is not null && (!coverage.MayHideCapacity(markedTurn) || capacityAt < replayStart);
        capture.Boundary = boundary;
        capture.Signals = [.. signals.Values];
        capture.Coverage = new(modelKnown ? markedTurn : null, capacityKnown ? markedTurn : null,
            coverage.OmittedModels || omittedTurnModels,
            coverage.OmittedCapacities || turnCapacities.Keys.Any(turn => turn != markedTurn));

        var received = receipts.GetValueOrDefault(ReminderWindowId(current)) ?? [];
        // Per-response usage can be recorded before the native aggregate event for the same response.
        foreach (var usage in new[] { response, native })
        {
            if (usage is null)
                continue;
            if (usage.Capacity is null && usage.Turn is string turn && turnCapacities.TryGetValue(turn, out var turnCapacity))
                usage.Capacity = turnCapacity.Capacity;
            if (usage.Matches(effectiveModel ?? latestModel, latestCapacity))
            {
                if (usage.Used < minimumUsed)
                    return default;
                return (current, usage.Used, usage.Capacity, received);
            }
        }
        return (current, null, null, received);
    }

    private static bool MatchesWindow(ReminderCheckpoint checkpoint, string window, long boundary) =>
        checkpoint.Boundary == boundary && checkpoint.Window.AsSpan(24).SequenceEqual(window.AsSpan(24));

    private static Usage? Sample(JsonElement payload, bool perResponse)
    {
        var info = perResponse ? payload : Property(payload, "info"u8);
        var usage = Property(info, perResponse ? "usage"u8 : "last_token_usage"u8);
        var used = Integer(Property(usage, "total_tokens"u8));
        if (used is null or < 0)
            return null;
        return new(used.Value, Positive(Property(info, "model_context_window"u8)),
            perResponse ? String(Property(payload, "turn_id"u8)) : null);
    }

    private static bool AssignModel(Usage? usage, string model, string? turn = null, bool global = false)
    {
        if (usage is null || usage.Model is not null || (!global && usage.Turn is not null && usage.Turn != turn))
            return false;
        usage.Model = model;
        return true;
    }

    private static byte[] Signal(string kind, Action<Utf8JsonWriter> writePayload)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using var writer = new Utf8JsonWriter(buffer);
        writer.WriteStartObject();
        writer.WriteString("type"u8, kind);
        writer.WriteStartObject("payload"u8);
        writePayload(writer);
        writer.WriteEndObject();
        writer.WriteEndObject();
        writer.Flush();
        return buffer.WrittenSpan.ToArray();
    }

    private static void WriteCapacity(Utf8JsonWriter writer, long? capacity)
    {
        if (capacity is long value)
            writer.WriteNumber("model_context_window"u8, value);
        else
            writer.WriteNull("model_context_window"u8);
    }

    private static byte[] UsageSignal(Usage usage, bool perResponse) => Signal(perResponse ? "token_usage_record" : "event_msg", writer =>
    {
        if (!perResponse)
        {
            writer.WriteString("type"u8, "token_count"u8);
            writer.WriteStartObject("info"u8);
        }
        writer.WriteStartObject(perResponse ? "usage"u8 : "last_token_usage"u8);
        writer.WriteNumber("total_tokens"u8, usage.Used);
        writer.WriteEndObject();
        if (perResponse)
            writer.WriteString("turn_id"u8, usage.Turn);
        WriteCapacity(writer, usage.Capacity);
        if (!perResponse)
            writer.WriteEndObject();
    });

    private static byte[] StartSignal(string eventName, string? turn, long? capacity) => Signal("event_msg", writer =>
    {
        writer.WriteString("type"u8, eventName);
        writer.WriteString("turn_id"u8, turn);
        WriteCapacity(writer, capacity);
    });

    private static byte[] ContextSignal(string? turn, bool nullTurn, string? model) => Signal("turn_context", writer =>
    {
        if (turn is not null || nullTurn)
            writer.WriteString("turn_id"u8, turn);
        else
            writer.WriteBoolean("turn_id"u8, false);
        writer.WriteString("model"u8, model);
    });

    private static byte[] SettingsSignal(string model) => Signal("event_msg", writer =>
    {
        writer.WriteString("type"u8, "thread_settings_applied"u8);
        writer.WriteStartObject("thread_settings"u8);
        writer.WriteString("model"u8, model);
        writer.WriteEndObject();
    });

    private static HashSet<int> GetLevels(Dictionary<string, HashSet<int>> receipts, string id)
    {
        if (!receipts.TryGetValue(id, out var levels))
            receipts.Add(id, levels = []);
        return levels;
    }

    [GeneratedRegex(@"\nNotify ID: \[(" + ReminderLevels + @"):([A-Za-z0-9_-]{8})\]\z", RegexOptions.CultureInvariant)]
    private static partial Regex CurrentReceipt();

    [GeneratedRegex(@"\n\[thread-memory:(" + ReminderLevels + @")\]\z", RegexOptions.CultureInvariant)]
    private static partial Regex LegacyReceipt();

    [GeneratedRegex(@"`memory write --window ([0-9a-f]{24}:(?:start|[0-9]{1,20}:[0-9a-f]{16}))`", RegexOptions.CultureInvariant)]
    private static partial Regex LegacyWindow();

    private static (string Id, HashSet<int> Tiers)? ParseReceipt(string text)
    {
        var wrapped = text.StartsWith(ReminderOpen, StringComparison.Ordinal) && text.EndsWith(ReminderClose, StringComparison.Ordinal);
        if (wrapped)
        {
            if (text.Length < ReminderOpen.Length + ReminderClose.Length)
                return null;
            text = text[ReminderOpen.Length..^ReminderClose.Length];
        }
        if (text.Contains("<thread_memory_reminder", StringComparison.Ordinal) || text.Contains("</thread_memory_reminder", StringComparison.Ordinal))
            return null;
        string id;
        var marker = CurrentReceipt().Match(text);
        if (marker.Success)
        {
            if (!wrapped)
                return null;
            id = marker.Groups[2].Value;
        }
        else
        {
            marker = LegacyReceipt().Match(text);
            if (!marker.Success)
                return null;
            var window = LegacyWindow().Match(text, 0, marker.Index);
            if (!window.Success)
                return null;
            id = ReminderWindowId(window.Groups[1].Value);
        }
        var tiers = new HashSet<int>();
        foreach (var tier in marker.Groups[1].Value.Split(','))
            if (!tiers.Add(int.Parse(tier, CultureInfo.InvariantCulture)))
                return null;
        return (id, tiers);
    }

    private static void ScanReceipts(ReadOnlyMemory<byte> raw, long offset, UInt128? ordinal,
        Dictionary<string, HashSet<int>>? active, Capture capture)
    {
        if (raw.Span[..Math.Min(PrefixBytes, raw.Length)].IndexOf("\"developer\""u8) < 0 ||
            raw.Span.IndexOf("\"hooks.additional_context\""u8) < 0 ||
            (raw.Span.IndexOf("Notify ID: ["u8) < 0 && raw.Span.IndexOf("[thread-memory:"u8) < 0))
            return;
        var matches = new List<(int Index, string Id, HashSet<int> Tiers)>();
        string? timestamp;
        try
        {
            using var record = Parse(raw);
            var payload = Property(record.RootElement, "payload"u8);
            if (!StringEquals(Property(payload, "type"u8), "message"u8) || !StringEquals(Property(payload, "role"u8), "developer"u8))
                return;
            var annotations = Property(payload, "internal_chat_message_metadata_passthrough"u8);
            var parts = Property(payload, "content"u8);
            var kinds = Property(annotations, "content_item_kinds"u8);
            var metadata = Property(annotations, "content_item_metadata"u8);
            if (parts.ValueKind != JsonValueKind.Array || kinds.ValueKind != JsonValueKind.Array || metadata.ValueKind != JsonValueKind.Array)
                return;
            timestamp = Timestamp(Property(record.RootElement, "timestamp"u8));
            using var content = parts.EnumerateArray();
            using var kind = kinds.EnumerateArray();
            using var source = metadata.EnumerateArray();
            var index = -1;
            while (content.MoveNext() && kind.MoveNext() && source.MoveNext())
            {
                index++;
                if (!StringEquals(kind.Current, "hooks.additional_context"u8) || !StringEquals(Property(content.Current, "type"u8), "input_text"u8))
                    continue;
                var provenance = Property(source.Current, "provenance"u8);
                if (!StringEquals(Property(provenance, "type"u8), "harness"u8) || Property(provenance, "hook"u8).ValueKind != JsonValueKind.True)
                    continue;
                var text = String(Property(content.Current, "text"u8));
                if (text is not null && ParseReceipt(text) is { } receipt)
                    matches.Add((index, receipt.Id, receipt.Tiers));
            }
        }
        catch (Exception error) when (IsScanError(error)) { return; }
        if (matches.Count == 0)
            return;

        var length = raw.Length;
        while (length > 0 && raw.Span[length - 1] == '\r')
            length--;
        var digest = Blake2s.HexDigest(raw.Span[..length], 16);
        // Older records lack an ordinal. Offset then distinguishes equal messages in the same millisecond.
        var position = ordinal is UInt128 persisted ? "n" + persisted.ToString(CultureInfo.InvariantCulture)
            : "b" + offset.ToString(CultureInfo.InvariantCulture);
        for (var i = matches.Count - 1; i >= 0; i--)
        {
            var match = matches[i];
            if (active is not null)
                GetLevels(active, match.Id).UnionWith(match.Tiers);
            var key = $"{position}:{match.Index.ToString(CultureInfo.InvariantCulture)}:{digest}";
            foreach (var tier in match.Tiers.OrderDescending())
                capture.Receipts.Add(new(match.Id, tier, key, timestamp));
        }
    }
}
