using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

if (args.Length > 1)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-memory.cs -- [Thread-Memory.exe]");
    return 2;
}

string cli = Path.GetFullPath(args.FirstOrDefault() ??
    Environment.GetEnvironmentVariable("THREAD_MEMORY_TEST_CLI_EXE") ?? PackagedCli());
if (!File.Exists(cli))
{
    Console.Error.WriteLine("Thread-Memory.exe was not found. Build the Native AOT CLI or pass its path.");
    return 2;
}

const string PatchHeader = "--- a/note\n+++ b/note\n";
const int Limit = 25_600;
const int NoticeThreshold = 10 * 1024;
string sandbox = Directory.CreateTempSubdirectory("thread-memory-note-").FullName;
string scenario = "UTF-8 notes, CLI thread selection, and lazy fork isolation";

try
{
    await VerifyFork(NewHome("fork"));
    Console.WriteLine($"Passed {scenario}.");
    scenario = "UTF-8 note limits and rejection of incomplete or over-limit patches";
    await VerifyBounds(NewHome("bounds"));
    Console.WriteLine($"Passed {scenario}.");
    return 0;
}
catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException
    or JsonException or KeyNotFoundException or TimeoutException)
{
    Console.Error.WriteLine($"Failed {scenario}: {error.Message}");
    return 1;
}
finally
{
    Directory.Delete(sandbox, recursive: true);
}

async Task VerifyFork(string home)
{
    string parent = MakeRollout(home);
    AssertRead(await Query(home, parent, ["read"]), parent, null, null);

    const string Original = "Goal\n\u76ee\u6807 \U0001f3af\nNext";
    JsonElement first = await Query(home, parent, ["write"], stdin: $"\uFEFF{Original}\r\n");
    AssertWrite(first, parent, Original, truncated: false);
    string savedAt = first.GetProperty("updated_at").GetString()!;
    AssertRead(await Query(home, parent, ["read"]), parent, Original, savedAt);

    string child = MakeRollout(home, parent, savedAt);
    const string NewerParent = "Goal\nParent after fork\nNext";
    JsonElement parentEdit = await Query(home, parent, ["write"], stdin: NewerParent);
    AssertRead(await Query(home, parent, ["--thread", child, "read"]), child, Original, savedAt);

    const string ChildLine = "\u5b50\u7ebf\u7a0b \U0001f680";
    const string ChildNote = $"Goal\n{ChildLine}\nReview";
    const string Diff = PatchHeader + $"@@ -2 +2 @@\n-\u76ee\u6807 \U0001f3af\n+{ChildLine}\n@@ -3 +3 @@\n-Next\n+Review\n";
    JsonElement patch = await Query(home, parent, ["patch", "--thread", child], stdin: Diff.ReplaceLineEndings("\r\n"));
    AssertWrite(patch, child, ChildNote);
    AssertRead(await Query(home, child, ["read"]), child, ChildNote, patch.GetProperty("updated_at").GetString());
    AssertRead(await Query(home, parent, ["read"]), parent, NewerParent, parentEdit.GetProperty("updated_at").GetString());
}

async Task VerifyBounds(string home)
{
    string thread = MakeRollout(home);
    const string Marker = "\n\n[Summary truncated]";
    const string Heading = "Goal\n";
    const string Multibyte = "\u754c";

    string noticeBody = new string('x', NoticeThreshold - Encoding.UTF8.GetByteCount(Heading));
    string atThreshold = Heading + noticeBody;
    JsonElement threshold = await Query(home, thread, ["write"], stdin: atThreshold);
    AssertWrite(threshold, thread, atThreshold, truncated: false);
    AssertRead(await Query(home, thread, ["read"]), thread, atThreshold, threshold.GetProperty("updated_at").GetString());

    JsonElement aboveThreshold = await Query(home, thread, ["patch"], stdin: PatchHeader + "@@ -1 +1 @@\n-Goal\n+Goals\n");
    string aboveThresholdNote = "Goals\n" + noticeBody;
    AssertWrite(aboveThreshold, thread, aboveThresholdNote);
    AssertRead(await Query(home, thread, ["read"]), thread, aboveThresholdNote, aboveThreshold.GetProperty("updated_at").GetString());

    string body = new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Multibyte)) + Multibyte;
    string atLimit = Heading + body;
    JsonElement boundary = await Query(home, thread, ["write"], stdin: atLimit + "\r\n");
    AssertWrite(boundary, thread, atLimit, truncated: false);
    AssertRead(await Query(home, thread, ["read"]), thread, atLimit, boundary.GetProperty("updated_at").GetString());

    JsonElement patched = await Query(home, thread, ["patch"], stdin: PatchHeader + "@@ -1 +1 @@\n-Goal\n+Next\n");
    string patchedAtLimit = "Next\n" + body;
    AssertWrite(patched, thread, patchedAtLimit);
    AssertRead(await Query(home, thread, ["read"]), thread, patchedAtLimit, patched.GetProperty("updated_at").GetString());

    string prefix = Heading + new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Marker) - 1);
    string saved = prefix + Marker;
    JsonElement written = await Query(home, thread, ["write"], stdin: prefix + Multibyte + new string('x', 70_000));
    AssertWrite(written, thread, saved, truncated: true);
    Require(Encoding.UTF8.GetByteCount(saved) == Limit - 1, "The fixture did not cross the limit inside a UTF-8 character.");
    string? updated = written.GetProperty("updated_at").GetString();
    AssertRead(await Query(home, thread, ["read"]), thread, saved, updated);

    const string FirstHunk = "@@ -1 +1 @@\n-Goal\n+Edit\n";
    foreach (string rejected in new[]
    {
        PatchHeader + FirstHunk + "@@ -4 +4 @@\n-Wrong old line\n+Ignored\n",
        PatchHeader + "@@ -1 +1 @@\n-Goal\n+Goal \u754c\n",
    })
    {
        CliResult error = await Invoke(home, thread, ["patch"], rejected);
        Require(error.ExitCode == 1 && error.Stdout.Length == 0 && !error.Stderr.TrimEnd().Contains('\n') &&
            Parse(error.Stderr).GetProperty("error").GetProperty("code").GetString() == "invalid_input",
            "An invalid patch did not return a single structured error on stderr.");
        AssertRead(await Query(home, thread, ["read"]), thread, saved, updated);
    }
}

string NewHome(string name)
{
    string home = Path.Combine(sandbox, $"Codex \u6d4b\u8bd5 {name}");
    Directory.CreateDirectory(Path.Combine(home, "sessions"));
    return home;
}

static string MakeRollout(string home, string? parent = null, string timestamp = "2026-01-01T00:00:00Z")
{
    string id = Guid.NewGuid().ToString();
    var header = new JsonObject
    {
        ["id"] = id, ["session_id"] = id, ["source"] = "vscode", ["timestamp"] = timestamp,
    };
    if (parent is not null)
        header["forked_from_id"] = parent;
    string path = Path.Combine(home, "sessions", $"rollout-2026-01-01T00-00-00-{id}.jsonl");
    File.WriteAllText(path, new JsonObject { ["type"] = "session_meta", ["payload"] = header }.ToJsonString() + '\n');
    return id;
}

static void AssertRead(JsonElement result, string thread, string? summary, string? updated)
{
    AssertSize(result, summary);
    Require(result.GetProperty("thread_id").GetString() == thread &&
        result.GetProperty("summary").GetString() == summary && result.GetProperty("updated_at").GetString() == updated,
        "The selected thread's saved text or timestamp differed from the expected snapshot.");
}

static void AssertWrite(JsonElement result, string thread, string expected, bool? truncated = null)
{
    AssertSize(result, expected);
    Require(result.GetProperty("saved").GetBoolean() && result.GetProperty("thread_id").GetString() == thread &&
        result.GetProperty("updated_at").GetDateTimeOffset().Offset == TimeSpan.Zero,
        "The write receipt did not report the saved note's thread and UTC timestamp.");
    if (truncated is bool value)
        Require(result.GetProperty("truncated").GetBoolean() == value, "The write receipt had the wrong truncation state.");
}

static void AssertSize(JsonElement result, string? summary)
{
    var fields = result.EnumerateObject();
    int expectedBytes = summary is null ? 0 : Encoding.UTF8.GetByteCount(summary);
    Require(fields.MoveNext() && fields.Current.NameEquals("bytes") && fields.Current.Value.GetInt32() == expectedBytes,
        "The result must start with the saved Markdown's UTF-8 byte count.");
    if (expectedBytes > NoticeThreshold)
        Require(fields.MoveNext() && fields.Current.NameEquals("notice") &&
            fields.Current.Value.GetString() == "Usually keep notes under 10 KiB. The recommended maximum is 15 KiB.",
            "The second field must give the expected size recommendation above 10 KiB.");
    else
        Require(!result.TryGetProperty("notice", out _), "There must be no size recommendation at or below 10 KiB.");
}

async Task<JsonElement> Query(string home, string thread, string[] arguments, string? stdin = null)
{
    CliResult result = await Invoke(home, thread, arguments, stdin);
    Require(result.ExitCode == 0 && result.Stderr.Length == 0, $"memory {string.Join(' ', arguments)} failed with exit {result.ExitCode}.");
    return Parse(result.Stdout);
}

async Task<CliResult> Invoke(string home, string thread, string[] arguments, string? stdin)
{
    var start = new ProcessStartInfo(cli)
    {
        WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        StandardInputEncoding = new UTF8Encoding(false, true),
        StandardOutputEncoding = new UTF8Encoding(false, true), StandardErrorEncoding = new UTF8Encoding(false, true),
    };
    start.ArgumentList.Add("memory");
    foreach (string argument in arguments)
        start.ArgumentList.Add(argument);
    start.Environment["CODEX_HOME"] = home;
    start.Environment["CODEX_SQLITE_HOME"] = home;
    start.Environment["CODEX_THREAD_ID"] = thread;
    using var process = Process.Start(start) ?? throw new InvalidOperationException("The CLI did not start.");
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    Task<string> stdout = process.StandardOutput.ReadToEndAsync();
    Task<string> stderr = process.StandardError.ReadToEndAsync();
    try
    {
        if (stdin is not null)
            await process.StandardInput.WriteAsync(stdin.AsMemory(), timeout.Token);
        process.StandardInput.Close();
        await process.WaitForExitAsync(timeout.Token);
    }
    catch (OperationCanceledException) when (timeout.IsCancellationRequested)
    {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
        throw new TimeoutException("The CLI exceeded the test timeout.");
    }
    return new CliResult(process.ExitCode, await stdout, await stderr);
}

static JsonElement Parse(string text)
{
    using var document = JsonDocument.Parse(text);
    return document.RootElement.Clone();
}

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static string PackagedCli([CallerFilePath] string source = "") =>
    Path.Combine(Path.GetDirectoryName(source)!, "..", "bin", "Thread-Memory.exe");

sealed record CliResult(int ExitCode, string Stdout, string Stderr);
