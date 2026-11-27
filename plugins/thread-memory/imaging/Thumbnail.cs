using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using Meziantou.Framework.Imaging;
using Meziantou.Framework.Imaging.Formats;

namespace ThreadMemoryImaging;

internal static unsafe class Thumbnail
{
    private static readonly ImageDecodeOptions PreviewDecode = new()
    {
        FrameLimit = 1,
        CmykConversion = new CmykConversionOptions(),
    };
    private static readonly WebPEncoder PreviewEncoder = new()
    {
        Compression = WebPCompression.Lossy,
        Quality = 80,
        MetadataHandling = MetadataHandling.Strip,
    };

    // A null path selects inline bytes. The callback borrows both spans until it returns.
    // Status: 0 success, 1 codec error (UTF-8, NUL terminated), 2 callback failure.
    [UnmanagedCallersOnly(EntryPoint = "thread_memory_thumbnail_v1", CallConvs = [typeof(CallConvCdecl)])]
    private static int Render(byte* sourcePathUtf8, byte* inlineBytes, int inlineLength, double scale, int maxResolution,
        delegate* unmanaged[Cdecl]<nint, byte*, int, int, int, byte*, int, int> emit, nint context,
        byte* error, int errorCapacity)
    {
        try
        {
            bool inline = sourcePathUtf8 == null;
            using var source = inline ? null : new FileStream(Marshal.PtrToStringUTF8((nint)sourcePathUtf8)!,
                FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var picture = inline
                ? Image.Load<Rgba32>(new ReadOnlySpan<byte>(inlineBytes, inlineLength), PreviewDecode)
                : Image.Load<Rgba32>(source!, PreviewDecode);
            picture.AutoOrient();
            int longestEdge = Math.Max(picture.Width, picture.Height);
            if (maxResolution > 0 && maxResolution < longestEdge)
                scale = Math.Min(scale, (double)maxResolution / longestEdge);
            int width = Math.Max(1, (int)Math.Round(picture.Width * scale));
            int height = Math.Max(1, (int)Math.Round(picture.Height * scale));
            if (width != picture.Width || height != picture.Height)
                picture.Resize(new ResizeOptions(width, height) { Filter = ResamplingFilter.Lanczos3 });

            using var output = new MemoryStream();
            (picture.PosterFrame ?? picture.Frames[0]).Save(output, PreviewEncoder);
            _ = output.TryGetBuffer(out var webp); // The default MemoryStream exposes its buffer.
            string extension = inline ? ImageExtension(picture.Metadata.SourceFormat) : "";
            Span<byte> extensionBytes = stackalloc byte[Encoding.UTF8.GetByteCount(extension)];
            Encoding.UTF8.GetBytes(extension, extensionBytes);
            fixed (byte* webpPtr = webp.AsSpan(), extensionPtr = extensionBytes)
                return emit(context, webpPtr, webp.Count, width, height, extensionPtr, extensionBytes.Length) == 0 ? 0 : 2;
        }
        catch (Exception failure)
        {
            if (error != null && errorCapacity > 0)
                WriteError(failure.Message, new Span<byte>(error, errorCapacity));
            return 1;
        }
    }

    private static string ImageExtension(ImageFormat format)
    {
        if (format == ImageFormat.Jpeg)
            return ".jpeg";
        string extension = ImageFormatInfo.Get(format).DefaultFileExtension;
        return extension.StartsWith('.') ? extension : '.' + extension;
    }

    private static void WriteError(string message, Span<byte> buffer)
    {
        int written = 0;
        foreach (var character in message.EnumerateRunes())
        {
            Rune printable = Rune.IsControl(character) ? new Rune(' ') : character;
            if (printable.Utf8SequenceLength >= buffer.Length - written)
                break;
            written += printable.EncodeToUtf8(buffer[written..]);
        }
        buffer[written] = 0;
    }
}
