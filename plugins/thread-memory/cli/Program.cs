using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static partial class Program
{
    private const string Usage = "Usage: Thread-Memory memory {read|write|patch} [--thread UUID] [--codex-home PATH]";
    private const int MaxNoteBytes = 12_288;
    private const int MaxPatchBytes = 128 * 1024;
    private const int StdOutputHandle = -11;
    private const string Truncation = "\n\n[Summary truncated]";
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static int Main(string[] args)
    {
        if (args is ["--help" or "-h"])
        {
            Console.WriteLine(Usage);
            return 0;
        }
        if (args is not ["memory", ..])
            return WriteError("invalid_arguments", Usage, 2);

        string? action = null;
        string? thread = null;
        string? home = null;
        for (int i = 1; i < args.Length; i++)
        {
            string option = args[i];
            if (option is "--help" or "-h")
            {
                Console.WriteLine(Usage);
                return 0;
            }
            if (action is null && option is ("read" or "write" or "patch"))
            {
                action = option;
                continue;
            }
            int equals = option.IndexOf('=');
            string name = equals < 0 ? option : option[..equals];
            if (name is not ("--thread" or "--codex-home"))
                return WriteError("invalid_arguments", $"Unrecognized argument: {name}", 2);
            if (equals < 0 && (i + 1 == args.Length || args[i + 1].StartsWith('-')))
                return WriteError("invalid_arguments", $"{name} expects one value.", 2);
            string value = equals >= 0 ? option[(equals + 1)..] : args[++i];
            if (name == "--thread")
                thread = value;
            else
                home = value;
        }
        if (action is null)
            return WriteError("invalid_arguments", Usage, 2);

        try
        {
            if (string.IsNullOrEmpty(thread))
                thread = Environment.GetEnvironmentVariable("CODEX_THREAD_ID");
            if (!Guid.TryParse(thread, out var id))
                throw new ArgumentException("memory requires --thread or CODEX_THREAD_ID with a thread UUID");
            home ??= Environment.GetEnvironmentVariable("CODEX_HOME") ??
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
            return Memory(action, home, id.ToString("D"));
        }
        catch (ThreadMemory.InheritanceUnavailable error)
        {
            return WriteError("invalid_input", error.Message);
        }
        catch (ThreadMemory.InvalidNoteRollout error)
        {
            return WriteError("invalid_rollout", error.Message, path: error.Path);
        }
        catch (FileNotFoundException error)
        {
            return WriteError("not_found", error.Message);
        }
        catch (UnauthorizedAccessException error)
        {
            return WriteError("permission_denied", error.Message);
        }
        catch (InvalidDataException error)
        {
            return WriteError("invalid_rollout", error.Message);
        }
        catch (IOException error)
        {
            return WriteError("io_error", error.Message);
        }
        catch (Exception error) when (error is ArgumentException or OverflowException)
        {
            return WriteError("invalid_input", error.Message);
        }
        catch (Exception error)
        {
            return WriteError("runtime_error", $"{error.GetType().Name}: {error.Message}");
        }
    }

    private static int Memory(string action, string home, string threadId)
    {
        string? summary = null;
        string? patch = null;
        bool truncated = false;
        if (action != "read")
        {
            using var stdin = Console.OpenStandardInput();
            if (action == "write")
                (summary, truncated) = ReadNote(stdin);
            else
            {
                byte[] input = new byte[MaxPatchBytes + 1];
                int length = stdin.ReadAtLeast(input, input.Length, false);
                if (length > MaxPatchBytes)
                    throw new ArgumentException($"memory patch input is limited to {MaxPatchBytes} UTF-8 bytes");
                patch = Utf8.GetString(WithoutBom(input.AsSpan(0, length)));
            }
        }

        var store = new HookStore(home);
        ThreadMemory.Note? current;
        string? inheritance = null;
        try
        {
            current = ThreadMemory.ReadForCli(store, home, threadId);
        }
        catch (ThreadMemory.InheritanceUnavailable error) when (action == "write")
        {
            current = null;
            inheritance = error.Message;
        }

        if (action == "read")
            return WriteResult(writer =>
            {
                writer.WriteString("thread_id", threadId);
                writer.WriteString("summary", current?.Summary);
                writer.WriteString("updated_at", current?.Summary is not null ? Timestamp(current.UpdatedUs) : null);
            });

        if (patch is not null)
        {
            if (current?.Summary is null)
                throw new FileNotFoundException("no thread note was saved to patch");
            summary = MemoryPatch.Apply(current.Summary, patch);
            if (string.IsNullOrWhiteSpace(summary))
                throw new ArgumentException("patch would leave an empty note");
            if (Utf8.GetByteCount(summary) > MaxNoteBytes)
                throw new ArgumentException($"patched note would exceed {MaxNoteBytes} UTF-8 bytes");
        }

        var saved = ThreadMemory.SaveForCli(store, threadId, summary!, current?.Revision ?? 0)
            ?? throw new ArgumentException(action == "patch"
                ? "thread note changed while applying the patch; read it again"
                : "thread note changed before saving. Read the thread note again.");
        return WriteResult(writer =>
        {
            writer.WriteBoolean("saved", true);
            writer.WriteString("thread_id", threadId);
            writer.WriteString("updated_at", Timestamp(saved.UpdatedUs));
            writer.WriteNumber("bytes", Utf8.GetByteCount(summary!));
            if (inheritance is not null)
                writer.WriteString("inheritance_unavailable", inheritance);
            if (action == "write")
                writer.WriteBoolean("truncated", truncated);
        });
    }

    private static (string Summary, bool Truncated) ReadNote(Stream stdin)
    {
        byte[] initial = new byte[MaxNoteBytes + 4];
        int length = stdin.ReadAtLeast(initial, initial.Length, false);
        var value = WithoutBom(initial.AsSpan(0, length));
        bool truncated = false;
        if (value.Length > MaxNoteBytes)
        {
            truncated = HasNoteContent(value[MaxNoteBytes..]);
            byte[] buffer = new byte[65_536];
            int read;
            while ((read = stdin.Read(buffer)) != 0)
                truncated |= HasNoteContent(buffer.AsSpan(0, read));
            value = value[..MaxNoteBytes];
        }

        string summary;
        if (truncated)
        {
            var prefix = value[..(MaxNoteBytes - Truncation.Length)];
            // A partial final UTF-8 character may cross the byte limit.
            char[] chars = new char[prefix.Length];
            int decoded = Utf8.GetDecoder().GetChars(prefix, chars, flush: false);
            summary = new string(chars, 0, decoded).TrimEnd('\r', '\n');
            return (string.IsNullOrWhiteSpace(summary) ? Truncation.TrimStart() : summary + Truncation, true);
        }

        summary = Utf8.GetString(value).TrimEnd('\r', '\n');
        if (string.IsNullOrWhiteSpace(summary))
            throw new ArgumentException("memory write requires a nonempty UTF-8 note on stdin");
        return (summary, false);
    }

    private static ReadOnlySpan<byte> WithoutBom(ReadOnlySpan<byte> bytes) =>
        bytes.StartsWith(Encoding.UTF8.Preamble) ? bytes[Encoding.UTF8.Preamble.Length..] : bytes;

    private static bool HasNoteContent(ReadOnlySpan<byte> bytes) =>
        bytes.IndexOfAnyExcept((byte)'\r', (byte)'\n') >= 0;

    private static string Timestamp(long microseconds) =>
        DateTimeOffset.UnixEpoch.AddTicks(checked(microseconds * 10))
            .ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);

    private static int WriteResult(Action<Utf8JsonWriter> fields)
    {
        try
        {
            // Console's standard stream suppresses Windows broken-pipe errors.
            using var handle = new SafeFileHandle(GetStdHandle(StdOutputHandle), ownsHandle: false);
            using var output = new FileStream(handle, FileAccess.Write);
            WriteJson(output, fields);
            return 0;
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 109 or 232)
        {
            return 141;
        }
    }

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GetStdHandle(int standardHandle);

    private static int WriteError(string code, string message, int status = 1, string? path = null)
    {
        using var output = Console.OpenStandardError();
        WriteJson(output, writer =>
        {
            writer.WriteStartObject("error");
            writer.WriteString("code", code);
            writer.WriteString("message", message.Length <= 400 ? message : message[..400] + "…");
            if (status == 2)
                writer.WriteString("hint", "Run Thread-Memory memory --help for valid options.");
            if (path is not null)
            {
                writer.WriteString("path", path);
                writer.WriteNumber("line", 1);
            }
            writer.WriteEndObject();
        });
        return status;
    }

    private static void WriteJson(Stream output, Action<Utf8JsonWriter> fields)
    {
        using var writer = new Utf8JsonWriter(output, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        writer.WriteStartObject();
        fields(writer);
        writer.WriteEndObject();
        writer.Flush();
        output.WriteByte((byte)'\n');
    }
}
