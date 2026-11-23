using System.Buffers.Binary;
using System.Numerics;

namespace ThreadMemoryHook;

internal static class Blake2s
{
    private static ReadOnlySpan<uint> InitialVector =>
    [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    private static ReadOnlySpan<byte> Permutations =>
    [
         0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15,
        14, 10,  4,  8,  9, 15, 13,  6,  1, 12,  0,  2, 11,  7,  5,  3,
        11,  8, 12,  0,  5,  2, 15, 13, 10, 14,  3,  6,  7,  1,  9,  4,
         7,  9,  3,  1, 13, 12, 11, 14,  2,  6,  5, 10,  4,  0, 15,  8,
         9,  0,  5,  7,  2,  4, 10, 15, 14,  1, 11, 12,  6,  8,  3, 13,
         2, 12,  6, 10,  0, 11,  8,  3,  4, 13,  7,  5, 15, 14,  1,  9,
        12,  5,  1, 15, 14, 13,  4, 10,  0,  7,  6,  3,  9,  2,  8, 11,
        13, 11,  7, 14, 12,  1,  3,  9,  5,  0, 15,  4,  8,  6,  2, 10,
         6, 15, 14,  9, 11,  3,  0,  8, 12,  2, 13,  7,  1,  4, 10,  5,
        10,  2,  8,  4,  7,  6,  1,  5, 15, 11,  9, 14,  3, 12, 13,  0,
    ];

    internal static string HexDigest(ReadOnlySpan<byte> data, int digestSize) =>
        Convert.ToHexStringLower(Hash(data, digestSize));

    internal static byte[] Hash(ReadOnlySpan<byte> data, int digestSize) =>
        Hash(data, [], digestSize);

    internal static byte[] Hash(ReadOnlySpan<byte> first, ReadOnlySpan<byte> second, int digestSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(digestSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(digestSize, 32);
        Span<uint> state = stackalloc uint[8];
        InitialVector.CopyTo(state);
        // The RFC 7693 parameter block includes the requested output length.
        state[0] ^= 0x01010000u | (uint)digestSize;

        Span<byte> block = stackalloc byte[64];
        ulong count = 0;
        ulong remaining = (ulong)first.Length + (ulong)second.Length;
        while (remaining > 64)
        {
            CopyBlock(ref first, ref second, block);
            count += 64;
            remaining -= 64;
            Compress(state, block, count, false);
        }
        first.CopyTo(block);
        second.CopyTo(block[first.Length..]);
        block[(int)remaining..].Clear();
        Compress(state, block, count + remaining, true);

        Span<byte> digest = stackalloc byte[32];
        for (int word = 0; word < state.Length; word++)
        {
            BinaryPrimitives.WriteUInt32LittleEndian(digest[(word * sizeof(uint))..], state[word]);
        }
        return digest[..digestSize].ToArray();
    }

    private static void CopyBlock(
        ref ReadOnlySpan<byte> first, ref ReadOnlySpan<byte> second, scoped Span<byte> destination)
    {
        int fromFirst = Math.Min(first.Length, destination.Length);
        int fromSecond = destination.Length - fromFirst;
        first[..fromFirst].CopyTo(destination);
        second[..fromSecond].CopyTo(destination[fromFirst..]);
        first = first[fromFirst..];
        second = second[fromSecond..];
    }

    private static void Compress(Span<uint> state, ReadOnlySpan<byte> block, ulong count, bool final)
    {
        Span<uint> words = stackalloc uint[16];
        Span<uint> working = stackalloc uint[16];
        for (int word = 0; word < words.Length; word++)
        {
            words[word] = BinaryPrimitives.ReadUInt32LittleEndian(block[(word * sizeof(uint))..]);
        }
        state.CopyTo(working);
        InitialVector.CopyTo(working[8..]);
        working[12] ^= (uint)count;
        working[13] ^= (uint)(count >> 32);
        if (final)
        {
            working[14] = ~working[14];
        }

        ReadOnlySpan<byte> permutations = Permutations;
        for (int round = 0; round < permutations.Length; round += 16)
        {
            ReadOnlySpan<byte> order = permutations.Slice(round, 16);
            Mix(working, 0, 4, 8, 12, words[order[0]], words[order[1]]);
            Mix(working, 1, 5, 9, 13, words[order[2]], words[order[3]]);
            Mix(working, 2, 6, 10, 14, words[order[4]], words[order[5]]);
            Mix(working, 3, 7, 11, 15, words[order[6]], words[order[7]]);
            Mix(working, 0, 5, 10, 15, words[order[8]], words[order[9]]);
            Mix(working, 1, 6, 11, 12, words[order[10]], words[order[11]]);
            Mix(working, 2, 7, 8, 13, words[order[12]], words[order[13]]);
            Mix(working, 3, 4, 9, 14, words[order[14]], words[order[15]]);
        }
        for (int word = 0; word < state.Length; word++)
        {
            state[word] ^= working[word] ^ working[word + 8];
        }
    }

    private static void Mix(Span<uint> v, int a, int b, int c, int d, uint x, uint y)
    {
        unchecked
        {
            v[a] += v[b] + x;
            v[d] = BitOperations.RotateRight(v[d] ^ v[a], 16);
            v[c] += v[d];
            v[b] = BitOperations.RotateRight(v[b] ^ v[c], 12);
            v[a] += v[b] + y;
            v[d] = BitOperations.RotateRight(v[d] ^ v[a], 8);
            v[c] += v[d];
            v[b] = BitOperations.RotateRight(v[b] ^ v[c], 7);
        }
    }
}
