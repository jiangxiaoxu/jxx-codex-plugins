using System.Buffers;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace ThreadMemoryHook;

internal readonly record struct TurnCoverage(
    string? ModelTurn = null,
    string? CapacityTurn = null,
    bool OmittedModels = false,
    bool OmittedCapacities = false)
{
    internal bool MayHideModel(string turn) => OmittedModels && ModelTurn != turn;
    internal bool MayHideCapacity(string turn) => OmittedCapacities && CapacityTurn != turn;
}

internal sealed record ReminderCheckpoint(
    long Offset,
    long Boundary,
    string Window,
    HashSet<int> Receipts,
    List<byte[]> Signals,
    TurnCoverage TurnCoverage);

internal readonly partial record struct RolloutFileStat(
    long Length, Int128 ModifiedNanoseconds, ulong Device, UInt128 Inode)
{
    private const long UnixEpochFileTime = 116444736000000000L;
    private const int FileIdInfoClass = 18;

    internal static RolloutFileStat Capture(FileStream stream)
    {
        SafeFileHandle handle = stream.SafeFileHandle;
        if (!GetFileInformationByHandle(handle, out HandleInfo info))
        {
            throw new IOException("Could not read the rollout file's metadata.",
                new Win32Exception(Marshal.GetLastPInvokeError()));
        }

        long length = checked((long)(((ulong)info.SizeHigh << 32) | info.SizeLow));
        Int128 modified = ((Int128)info.LastWriteTime.Value - UnixEpochFileTime) * 100;
        // Modern CPython exposes the volume serial and full 128-bit FILE_ID_INFO.
        if (GetFileInformationByHandleEx(handle, FileIdInfoClass, out FileIdInfo id, 24))
        {
            return new RolloutFileStat(length, modified, id.Device, ((UInt128)id.IdHigh << 64) | id.IdLow);
        }

        ulong inode = ((ulong)info.IdHigh << 32) | info.IdLow;
        return new RolloutFileStat(length, modified, info.Device, inode);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint Low;
        public uint High;
        public readonly ulong Value => ((ulong)High << 32) | Low;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInfo
    {
        public uint Attributes;
        public FileTime CreationTime;
        public FileTime LastAccessTime;
        public FileTime LastWriteTime;
        public uint Device;
        public uint SizeHigh;
        public uint SizeLow;
        public uint LinkCount;
        public uint IdHigh;
        public uint IdLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileIdInfo
    {
        public ulong Device;
        public ulong IdLow;
        public ulong IdHigh;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInfo info);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetFileInformationByHandleEx(
        SafeFileHandle handle, int informationClass, out FileIdInfo info, uint size);
}

internal static class RolloutCursor
{
    private const int MaxCheckpointChars = 65_536;
    private const int AnchorBytes = 4_096;
    private const int Version = 2;

    internal static ReminderCheckpoint? ReadCheckpoint(
        string path, FileStream stream, RolloutFileStat stat, string segment,
        long headerEnd, string? raw, int maxAppend)
    {
        if (string.IsNullOrEmpty(raw) || raw.Length > MaxCheckpointChars || stat.Inode == 0)
        {
            return null;
        }
        try
        {
            using JsonDocument json = JsonDocument.Parse(raw);
            JsonElement record = json.RootElement;
            if (record.ValueKind != JsonValueKind.Object ||
                !TryReadInteger(record, "version", out long version) || version != Version ||
                !MatchesIdentity(record, path, stat, segment) ||
                !TryReadInteger(record, "offset", out long offset) || offset < headerEnd || offset > stat.Length ||
                !TryReadInteger(record, "boundary", out long boundary) || boundary < headerEnd || boundary > offset ||
                (stat.Length - maxAppend > headerEnd && boundary <= stat.Length - maxAppend) ||
                !record.TryGetProperty("mtime_ns", out JsonElement mtimeValue) ||
                mtimeValue.ValueKind != JsonValueKind.Number ||
                !Int128.TryParse(mtimeValue.GetRawText(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture,
                    out Int128 mtime) ||
                (offset == stat.Length && mtime != stat.ModifiedNanoseconds) ||
                !TryReadString(record, "window", out string? window) || window is null ||
                !ValidWindow(window, segment, boundary, offset) ||
                !record.TryGetProperty("receipts", out JsonElement receipts) ||
                receipts.ValueKind != JsonValueKind.Array || receipts.GetArrayLength() > 101 ||
                !record.TryGetProperty("signals", out JsonElement signals) || signals.ValueKind != JsonValueKind.Array ||
                !record.TryGetProperty("turn_coverage", out JsonElement coverage) ||
                !TryReadCoverage(coverage, out TurnCoverage turnCoverage) ||
                !TryReadString(record, "anchor", out string? anchor) || anchor is null || anchor != Anchor(stream, offset))
            {
                return null;
            }

            var receiptLevels = new HashSet<int>();
            foreach (JsonElement receipt in receipts.EnumerateArray())
            {
                if (receipt.ValueKind != JsonValueKind.Number || !receipt.TryGetInt32(out int level) || level is < 0 or > 100)
                {
                    return null;
                }
                receiptLevels.Add(level);
            }

            var records = new List<byte[]>(signals.GetArrayLength());
            foreach (JsonElement signal in signals.EnumerateArray())
            {
                if (signal.ValueKind != JsonValueKind.Object)
                {
                    return null;
                }
                records.Add(Encoding.UTF8.GetBytes(signal.GetRawText()));
            }
            return new ReminderCheckpoint(offset, boundary, window, receiptLevels, records, turnCoverage);
        }
        catch (Exception error) when (error is JsonException or IOException or InvalidOperationException)
        {
            return null;
        }
    }

    internal static string? WriteCheckpoint(
        string path, FileStream stream, RolloutFileStat stat, string segment, long boundary, string window,
        IReadOnlySet<int> receipts, IReadOnlyList<byte[]> signals, TurnCoverage turnCoverage)
    {
        if (stat.Inode == 0 || stat.Length == 0)
        {
            return null;
        }
        try
        {
            string? anchor = Anchor(stream, stat.Length);
            if (anchor is null || RolloutFileStat.Capture(stream) != stat)
            {
                return null;
            }
            var buffer = new ArrayBufferWriter<byte>();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                writer.WriteNumber("version", Version);
                writer.WriteStartArray("file");
                writer.WriteStringValue(Path.GetFullPath(path));
                writer.WriteStringValue(stat.Device.ToString(CultureInfo.InvariantCulture));
                writer.WriteStringValue(stat.Inode.ToString(CultureInfo.InvariantCulture));
                writer.WriteStringValue(segment);
                writer.WriteEndArray();
                writer.WriteNumber("offset", stat.Length);
                writer.WriteNumber("boundary", boundary);
                writer.WritePropertyName("mtime_ns");
                writer.WriteRawValue(stat.ModifiedNanoseconds.ToString(CultureInfo.InvariantCulture));
                writer.WriteString("anchor", anchor);
                writer.WriteString("window", window);
                writer.WriteStartArray("receipts");
                foreach (int level in receipts.Order())
                {
                    writer.WriteNumberValue(level);
                }
                writer.WriteEndArray();
                writer.WriteStartArray("signals");
                foreach (byte[] signal in signals)
                {
                    writer.WriteRawValue(signal);
                }
                writer.WriteEndArray();
                writer.WriteStartObject("turn_coverage");
                writer.WriteString("model_turn", turnCoverage.ModelTurn);
                writer.WriteString("capacity_turn", turnCoverage.CapacityTurn);
                writer.WriteBoolean("omitted_models", turnCoverage.OmittedModels);
                writer.WriteBoolean("omitted_capacities", turnCoverage.OmittedCapacities);
                writer.WriteEndObject();
                writer.WriteEndObject();
            }
            string raw = Encoding.UTF8.GetString(buffer.WrittenSpan);
            return raw.Length <= MaxCheckpointChars ? raw : null;
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    private static bool MatchesIdentity(JsonElement record, string path, RolloutFileStat stat, string segment)
    {
        return record.TryGetProperty("file", out JsonElement file) &&
            file.ValueKind == JsonValueKind.Array && file.GetArrayLength() == 4 &&
            MatchesString(file[0], Path.GetFullPath(path)) &&
            MatchesString(file[1], stat.Device.ToString(CultureInfo.InvariantCulture)) &&
            MatchesString(file[2], stat.Inode.ToString(CultureInfo.InvariantCulture)) &&
            MatchesString(file[3], segment);
    }

    private static bool MatchesString(JsonElement item, string expected) =>
        item.ValueKind == JsonValueKind.String && item.ValueEquals(expected);

    private static bool TryReadInteger(JsonElement item, string name, out long value)
    {
        value = 0;
        return item.TryGetProperty(name, out JsonElement property) &&
            property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out value);
    }

    private static bool TryReadString(JsonElement item, string name, out string? value)
    {
        value = null;
        if (!item.TryGetProperty(name, out JsonElement property))
        {
            return false;
        }
        if (property.ValueKind == JsonValueKind.String)
        {
            value = property.GetString();
            return true;
        }
        return property.ValueKind == JsonValueKind.Null;
    }

    private static bool ValidWindow(string window, string segment, long boundary, long offset)
    {
        if (segment.Length != 24 || !IsHex(segment) || window.Length <= segment.Length ||
            window[segment.Length] != ':' || !window.StartsWith(segment, StringComparison.Ordinal))
        {
            return false;
        }
        ReadOnlySpan<char> suffix = window.AsSpan(segment.Length + 1);
        if (suffix.SequenceEqual("start"))
        {
            return true;
        }
        int separator = suffix.IndexOf(':');
        return separator is >= 1 and <= 20 && suffix.Length == separator + 17 &&
            long.TryParse(suffix[..separator], NumberStyles.None, CultureInfo.InvariantCulture, out long at) &&
            at == boundary && boundary != offset && IsHex(suffix[(separator + 1)..]);
    }

    private static bool IsHex(ReadOnlySpan<char> digits)
    {
        foreach (char digit in digits)
        {
            if (digit is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                return false;
            }
        }
        return true;
    }

    private static bool TryReadCoverage(JsonElement item, out TurnCoverage coverage)
    {
        coverage = default;
        if (item.ValueKind != JsonValueKind.Object || item.EnumerateObject().Count() != 4 ||
            !TryReadString(item, "model_turn", out string? modelTurn) ||
            !TryReadString(item, "capacity_turn", out string? capacityTurn) ||
            !item.TryGetProperty("omitted_models", out JsonElement omittedModels) ||
            omittedModels.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !item.TryGetProperty("omitted_capacities", out JsonElement omittedCapacities) ||
            omittedCapacities.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return false;
        }
        coverage = new TurnCoverage(modelTurn, capacityTurn, omittedModels.GetBoolean(), omittedCapacities.GetBoolean());
        return true;
    }

    private static string? Anchor(FileStream stream, long offset)
    {
        int size = (int)Math.Min(offset, AnchorBytes);
        if (size == 0)
        {
            return null;
        }
        stream.Position = offset - size;
        Span<byte> tail = stackalloc byte[size];
        stream.ReadExactly(tail);
        return tail[^1] == (byte)'\n' ? Blake2s.HexDigest(tail, 16) : null;
    }
}
