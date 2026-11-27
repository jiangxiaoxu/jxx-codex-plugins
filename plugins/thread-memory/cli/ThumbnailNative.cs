using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

namespace ThreadMemoryCli;

internal static partial class HistoryMedia
{
    private sealed unsafe class ThumbnailOutput(string outputDirectory, string baseName, bool preserveExtension)
    {
        private const string LibraryName = "Thread-Memory-Imaging.dll";
        private const string EntryPoint = "thread_memory_thumbnail_v1";
        private static readonly Lazy<nint> Encoder = new(LoadEncoder);
        private static readonly UTF8Encoding PathEncoding = new(false, true);
        private readonly string directory = outputDirectory;
        private readonly string name = baseName;
        private readonly bool inline = preserveExtension;
        private Exception? writeError;

        internal string? File { get; private set; }
        internal int Width { get; private set; }
        internal int Height { get; private set; }
        internal string? SourceExtension { get; private set; }

        internal void Create(string? sourcePath, ReadOnlySpan<byte> sourceBytes, double scale, int? maxResolution)
        {
            var encode = (delegate* unmanaged[Cdecl]<byte*, byte*, int, double, int,
                delegate* unmanaged[Cdecl]<nint, byte*, int, int, int, byte*, int, int>, nint, byte*, int, int>)Encoder.Value;
            byte[]? path = sourcePath is null ? null : PathEncoding.GetBytes(sourcePath + '\0');
            Span<byte> message = stackalloc byte[4096];
            message.Clear();
            // The callback consumes the DLL's bytes during this call and never retains a native pointer.
            GCHandle context = GCHandle.Alloc(this);
            int status;
            try
            {
                fixed (byte* pathPtr = path, sourcePtr = sourceBytes, messagePtr = message)
                    status = encode(pathPtr, sourcePtr, sourceBytes.Length, scale, maxResolution ?? 0,
                        &Emit, GCHandle.ToIntPtr(context), messagePtr, message.Length);
            }
            finally
            {
                context.Free();
            }

            if (status == 0 && File is not null)
                return;
            if (writeError is not null)
                throw new IOException(writeError.Message, writeError);
            int length = message.IndexOf((byte)0);
            if (status == 1 && length > 0)
                throw new IOException(Encoding.UTF8.GetString(message[..length]));
            throw new IOException($"{LibraryName} did not return a thumbnail (status {status}).");
        }

        private static nint LoadEncoder()
        {
            nint library = 0;
            try
            {
                library = NativeLibrary.Load(Path.Combine(AppContext.BaseDirectory, LibraryName));
                return NativeLibrary.GetExport(library, EntryPoint);
            }
            catch (Exception error) when (error is DllNotFoundException or BadImageFormatException or EntryPointNotFoundException)
            {
                if (library != 0)
                    NativeLibrary.Free(library);
                throw new IOException($"Could not load {LibraryName}: {error.Message}", error);
            }
        }

        [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
        private static int Emit(nint context, byte* webp, int length, int width, int height, byte* extension, int extensionLength)
        {
            ThumbnailOutput? result = null;
            try
            {
                result = (ThumbnailOutput)GCHandle.FromIntPtr(context).Target!;
                result.Width = width;
                result.Height = height;
                if (result.inline)
                    result.SourceExtension = Encoding.UTF8.GetString(new ReadOnlySpan<byte>(extension, extensionLength));
                Directory.CreateDirectory(result.directory);
                result.File = WriteNew(result.directory, $"{result.name}-{width}x{height}", ".webp",
                    output => output.Write(new ReadOnlySpan<byte>(webp, length)));
                return 0;
            }
            catch (Exception error)
            {
                if (result is not null)
                    result.writeError = error;
                return 1;
            }
        }
    }
}
