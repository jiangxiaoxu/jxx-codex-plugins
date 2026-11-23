using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace ThreadMemoryHook;

internal static class Program
{
    public static int Main(string[] args)
    {
        var home = Environment.GetEnvironmentVariable("CODEX_HOME") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        if (args.Length != 0)
        {
            if (args is not ["--codex-home", var explicitHome] || explicitHome.Length == 0)
                return Error("invalid_arguments", "Usage: Thread-Memory-Hook [--codex-home PATH]");
            home = explicitHome;
        }

        try
        {
            using var input = Console.OpenStandardInput();
            using var request = JsonDocument.Parse(input, new JsonDocumentOptions { MaxDepth = 1_000 });
            if (request.RootElement.ValueKind != JsonValueKind.Object)
                return Error("invalid_input", "Hook stdin must contain a JSON object.");

            SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
            var context = HookInstructions.Get(request.RootElement, home);
            if (context is null)
                return 0;

            using var stdout = Console.OpenStandardOutput();
            using var output = new Utf8JsonWriter(stdout);
            output.WriteStartObject();
            output.WriteStartObject("hookSpecificOutput");
            output.WriteString("hookEventName", request.RootElement.GetProperty("hook_event_name").GetString());
            output.WriteString("additionalContext", context);
            output.WriteEndObject();
            output.WriteEndObject();
            output.Flush();
            stdout.WriteByte((byte)'\n');
            return 0;
        }
        catch (JsonException error)
        {
            return Error("invalid_input", $"Invalid hook JSON from stdin: {error.Message}");
        }
        catch (SqliteException error)
        {
            return Error("sqlite_error", error.Message);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return Error("io_error", error.Message);
        }
        catch (Exception error)
        {
            return Error("internal_error", error.Message);
        }
    }

    private static int Error(string code, string message)
    {
        using var stderr = Console.OpenStandardError();
        using var output = new Utf8JsonWriter(stderr);
        output.WriteStartObject();
        output.WriteStartObject("error");
        output.WriteString("code", code);
        output.WriteString("message", message);
        output.WriteEndObject();
        output.WriteEndObject();
        output.Flush();
        stderr.WriteByte((byte)'\n');
        return 1;
    }
}
