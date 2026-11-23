using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ThreadMemoryHook;

internal readonly partial record struct RolloutPath(string Key, string Name, RolloutFileStat Stat)
{
    private const int InitialPathLength = 512;
    private const int MaximumPathLength = 32_768;
    private const uint OpenedName = 8;

    internal static RolloutPath Resolve(string original, FileStream stream)
    {
        RolloutFileStat stat = RolloutFileStat.Capture(stream);
        SafeFileHandle handle = stream.SafeFileHandle;
        string path = ReadFinalPath(handle, 0) ?? ReadFinalPath(handle, OpenedName) ?? ExtendedPath(original);
        return new RolloutPath(path, Path.GetFileName(path), stat);
    }

    private static string ExtendedPath(string original)
    {
        string path = Path.GetFullPath(original);
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal) || path.StartsWith(@"\\.\", StringComparison.Ordinal))
        {
            return path;
        }
        return path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..] : @"\\?\" + path;
    }

    private static unsafe string? ReadFinalPath(SafeFileHandle handle, uint flags)
    {
        char* shortPath = stackalloc char[InitialPathLength];
        uint length = GetFinalPathNameByHandleW(handle, shortPath, InitialPathLength, flags);
        if (length is > 0 and < InitialPathLength)
        {
            return new string(shortPath, 0, (int)length);
        }
        if (length is < InitialPathLength or > MaximumPathLength)
        {
            return null;
        }

        var longPath = new char[length];
        fixed (char* chars = longPath)
        {
            length = GetFinalPathNameByHandleW(handle, chars, length, flags);
        }
        return length > 0 && length < longPath.Length ? new string(longPath, 0, (int)length) : null;
    }

    [LibraryImport("kernel32.dll")]
    private static unsafe partial uint GetFinalPathNameByHandleW(
        SafeFileHandle handle, char* filePath, uint characterCount, uint flags);
}
