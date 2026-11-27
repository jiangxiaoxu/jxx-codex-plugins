using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using ThreadMemoryHook;

namespace ThreadMemoryCli;

internal static partial class Program
{
    internal const int MaxNoteBytes = 32 * 1024;
    internal const int NoteNoticeThresholdKiB = 20;
    private const int NoteWritingLimitKiB = 26;
    private const int StdOutputHandle = -11;
    private const string Truncation = "\n\n[Summary truncated]";
    private static readonly string NoteSizeNotice = FormattableString.Invariant(
        $"Keep the note at or below {NoteNoticeThresholdKiB} KiB unless essential details need more space. Stay within {NoteWritingLimitKiB} KiB.");
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static int Main(string[] args)
    {
        bool plainMemory = args is ["memory", ..];
        try
        {
            var options = CliOptions.Parse(args);
            if (options.Help)
                return WriteStdout(output => output.Write(Utf8.GetBytes(options.Usage() + "\n")));
            Console.CancelKeyPress += (_, signal) =>
            {
                signal.Cancel = true;
                Environment.Exit(Fail("interrupted", "Interrupted by user.", 130));
            };
            SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
            if (options.Command == "memory")
            {
                if (!Guid.TryParse(options.Thread, out var id))
                    throw new CliInputException("memory requires --thread or CODEX_THREAD_ID with a thread UUID");
                return Memory(options.Pattern!, options.Home, id.ToString("D"));
            }
            if (options.Command == "diagnostics")
                return WriteDocument(Diagnostics.Run(options));
            options.ResolveStdin();
            return Query(options);
        }
        catch (CliInputException error)
        {
            return Fail(error.Code, error.Message, error.Code == "invalid_arguments" ? 2 : 1);
        }
        catch (RolloutReadException error)
        {
            return Fail("invalid_rollout", error.Message, path: error.Path, line: error.Line,
                hint: error.Message.StartsWith("invalid JSONL", StringComparison.Ordinal)
                    ? "Retry with --salvage to skip damaged records." : null);
        }
        catch (ThreadMemory.InheritanceUnavailable error)
        {
            return Fail("invalid_input", error.Message);
        }
        catch (ThreadMemory.InvalidNoteRollout error)
        {
            return Fail("invalid_rollout", error.Message, path: error.Path, line: 1);
        }
        catch (FileNotFoundException error)
        {
            return Fail("not_found", error.Message);
        }
        catch (UnauthorizedAccessException error)
        {
            return Fail("permission_denied", error.Message);
        }
        catch (InvalidDataException error)
        {
            return Fail("invalid_rollout", error.Message);
        }
        catch (IOException error)
        {
            return Fail("io_error", error.Message);
        }
        catch (Exception error) when (error is ArgumentException or OverflowException)
        {
            return Fail("invalid_input", error.Message);
        }
        catch (Exception error)
        {
            return Fail("runtime_error", $"{error.GetType().Name}: {error.Message}");
        }

        int Fail(string code, string message, int status = 1, string? path = null, long? line = null, string? hint = null) =>
            WriteError(plainMemory, code, message, status, path, line, hint);
    }

    private static int Query(CliOptions options)
    {
        string? destination = options.One("--output") is string path ? Path.GetFullPath(path) : null;
        if (destination is not null && File.Exists(destination))
            throw new CliInputException($"Output already exists: {destination}", "output_exists");
        // A single attachment lookup completes index verification before any export writes.
        bool canRetry = options.Command switch
        {
            "export-image" or "export-audio" => options.Many("--id").Count == 1,
            "recover" => !options.Has("--export-images"),
            _ => true,
        };
        var source = HistorySource.Open(options, allowIndex: canRetry);
        JsonObject result;
        try
        {
            result = Dispatch(options, source);
        }
        catch (HistoryIndexUnavailable) when (canRetry)
        {
            source = HistorySource.Open(options, allowIndex: false);
            result = Dispatch(options, source);
        }
        var gaps = source.MissingBaseRollouts;
        var damaged = source.DamagedRecords;
        if (gaps.Count != 0)
            result["missing_base_rollouts"] = gaps.DeepClone();
        if (damaged.Count != 0)
        {
            int count = damaged.Count;
            int shown = destination is null ? Math.Min(count, 20) : count;
            result["damaged_records"] = new JsonObject
            {
                ["count"] = count,
                ["truncated"] = shown < count,
                ["items"] = new JsonArray(damaged.Take(shown).Select(item => item?.DeepClone()).ToArray()),
            };
        }

        void WriteOutput(Stream output)
        {
            if (options.One("--format") != "markdown")
            {
                WriteJson(output, writer => result.WriteTo(writer));
                return;
            }
            string markdown = options.Command switch
            {
                "search" => HistoryMarkdown.FormatSearch(result),
                "transcript" => HistoryChat.FormatMarkdown(result),
                _ => throw new InvalidOperationException($"No Markdown formatter for {options.Command}.")
            };
            output.Write(Utf8.GetBytes(markdown));
        }
        if (destination is null)
            return WriteStdout(WriteOutput);

        long length;
        try
        {
            using var file = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            WriteOutput(file);
            length = file.Position;
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 80 or 183)
        {
            throw new CliInputException($"Output already exists: {destination}", "output_exists");
        }
        var receipt = new JsonObject { ["output"] = destination, ["bytes"] = length };
        if (result.TryGetPropertyValue("next_cursor", out var cursor))
            receipt["next_cursor"] = cursor?.DeepClone();
        if (damaged.Count != 0)
            receipt["damaged_record_count"] = damaged.Count;
        if (gaps.Count != 0)
            receipt["missing_base_rollout_count"] = gaps.Count;
        return WriteDocument(receipt);
    }

    private static JsonObject Dispatch(CliOptions options, HistorySource source) => options.Command switch
    {
        "search" or "read" or "inventory" => HistoryRecords.Run(options, source),
        "tool-input" or "tool-output" => HistoryTools.Run(options, source),
        "transcript" => HistoryChat.Run(options, source),
        "recover" => HistoryRecovery.Run(options, source),
        "inspect" or "lineage" or "windows" or "tokens" or "instructions" => HistoryMetadata.Run(options, source),
        "images" or "attachments" or "export-image" or "export-audio" => HistoryMedia.Run(options, source),
        _ => throw new InvalidOperationException($"Unrouted command: {options.Command}."),
    };

    private static int Memory(string action, string home, string threadId)
    {
        var store = new HookStore(home);
        if (action == "read")
        {
            var note = ThreadMemory.ReadForCli(store, home, threadId, ReadNoteHeader);
            int status = WriteStdout(output => output.Write(Utf8.GetBytes(note?.Summary ?? "")));
            if (status == 0 && note?.Summary is { Length: > 0 } &&
                Guid.TryParse(Environment.GetEnvironmentVariable("CODEX_THREAD_ID"), out Guid caller) &&
                threadId == caller.ToString("D"))
                MemoryReads.Record(store, threadId);
            return status;
        }

        string summary;
        bool truncated;
        using (var stdin = Console.OpenStandardInput())
            (summary, truncated) = ReadNote(stdin);

        ThreadMemory.Note? current;
        string? inheritance = null;
        try
        {
            current = ThreadMemory.ReadForCli(store, home, threadId, ReadNoteHeader);
        }
        catch (ThreadMemory.InheritanceUnavailable error)
        {
            current = null;
            inheritance = error.Message;
        }

        if (ThreadMemory.SaveForCli(store, threadId, summary, current?.Revision ?? 0) is null)
            throw new ArgumentException("thread note changed before saving. Read the thread note again.");
        int bytes = Utf8.GetByteCount(summary);
        var receipt = new StringBuilder();
        receipt.Append(FormattableString.Invariant($"Note saved. Total size: {bytes:N0} UTF-8 bytes.\n"));
        if (bytes > NoteNoticeThresholdKiB * 1024)
            receipt.Append(NoteSizeNotice).Append('\n');
        if (truncated)
            receipt.Append("The note was truncated to the save limit.\n");
        if (inheritance is not null)
            receipt.Append("Note inheritance was unavailable: ").Append(MediaText.OmitDataUrls(inheritance)).Append('\n');
        return WriteStdout(output => output.Write(Encoding.UTF8.GetBytes(receipt.ToString())));
    }

    private static JsonElement ReadNoteHeader(string path)
    {
        try
        {
            return HistorySource.ReadHeader(path);
        }
        catch (RolloutReadException error)
        {
            throw new ThreadMemory.InvalidNoteRollout(path, error.Message);
        }
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

    private static int WriteDocument(JsonObject result) =>
        WriteStdout(output => WriteJson(output, writer => result.WriteTo(writer)));

    private static int WriteStdout(Action<Stream> write)
    {
        try
        {
            // Console's standard stream suppresses Windows broken-pipe errors.
            using var handle = new SafeFileHandle(GetStdHandle(StdOutputHandle), ownsHandle: false);
            using var output = new FileStream(handle, FileAccess.Write);
            write(output);
            return 0;
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 109 or 232)
        {
            return 141;
        }
    }

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GetStdHandle(int standardHandle);

    private static int WriteError(bool plain, string code, string message, int status, string? path,
        long? line, string? hint)
    {
        message = MediaText.OmitDataUrls(message);
        message = message.Length <= 400 ? message : message[..400] + "…";
        hint = hint is not null ? MediaText.OmitDataUrls(hint)
            : status == 2 ? "Run Thread-Memory COMMAND --help for valid options." : null;
        using var output = Console.OpenStandardError();
        if (plain)
        {
            var text = new StringBuilder().Append("Failed [").Append(code).Append("]: ")
                .Append(message.ReplaceLineEndings(" ")).Append('\n');
            if (path is not null)
                text.Append("Path: ").Append(MediaText.OmitDataUrls(path)).Append('\n');
            if (line is long position)
                text.Append("Line: ").Append(position).Append('\n');
            if (hint is not null)
                text.Append("Hint: ").Append(hint).Append('\n');
            output.Write(Encoding.UTF8.GetBytes(text.ToString()));
            return status;
        }
        WriteObject(output, writer =>
        {
            writer.WriteStartObject("error");
            writer.WriteString("code", code);
            writer.WriteString("message", message);
            if (hint is not null)
                writer.WriteString("hint", hint);
            if (path is not null)
                writer.WriteString("path", MediaText.OmitDataUrls(path));
            if (line is long position)
                writer.WriteNumber("line", position);
            writer.WriteEndObject();
        });
        return status;
    }

    private static void WriteObject(Stream output, Action<Utf8JsonWriter> fields) =>
        WriteJson(output, writer =>
        {
            writer.WriteStartObject();
            fields(writer);
            writer.WriteEndObject();
        });

    private static void WriteJson(Stream output, Action<Utf8JsonWriter> document)
    {
        using var writer = new Utf8JsonWriter(output, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        document(writer);
        writer.Flush();
        output.WriteByte((byte)'\n');
    }
}
