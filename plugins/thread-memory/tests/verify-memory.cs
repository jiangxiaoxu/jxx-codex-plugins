using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
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
const int NoticeThreshold = 15 * 1024;
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
catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException or TimeoutException)
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
    AssertRead(await Query(home, parent, ["read"]), "");

    const string Original = "Goal\n\u76ee\u6807 \U0001f3af\nNext";
    string first = await Query(home, parent, ["write"], stdin: $"\uFEFF{Original}\r\n");
    string savedAt = AssertSaved(first, parent, Original);
    AssertRead(await Query(home, parent, ["read"]), Original);

    string child = MakeRollout(home, parent, savedAt);
    const string NewerParent = "Goal\nParent after fork\nNext";
    AssertSaved(await Query(home, parent, ["write"], stdin: NewerParent), parent, NewerParent);
    AssertRead(await Query(home, parent, ["--thread", child, "read"]), Original);

    const string ChildLine = "\u5b50\u7ebf\u7a0b \U0001f680";
    const string ChildNote = $"Goal\n{ChildLine}\nReview";
    const string Diff = PatchHeader + $"@@ -2 +2 @@\n-\u76ee\u6807 \U0001f3af\n+{ChildLine}\n@@ -3 +3 @@\n-Next\n+Review\n";
    string patch = await Query(home, parent, ["patch", "--thread", child], stdin: Diff.ReplaceLineEndings("\r\n"));
    AssertSaved(patch, child, ChildNote);
    AssertRead(await Query(home, child, ["read"]), ChildNote);
    AssertRead(await Query(home, parent, ["read"]), NewerParent);
}

async Task VerifyBounds(string home)
{
    string thread = MakeRollout(home);
    const string Marker = "\n\n[Summary truncated]";
    const string Heading = "Goal\n";
    const string Multibyte = "\u754c";

    string noticeBody = new string('x', NoticeThreshold - Encoding.UTF8.GetByteCount(Heading));
    string atThreshold = Heading + noticeBody;
    AssertSaved(await Query(home, thread, ["write"], stdin: atThreshold), thread, atThreshold);
    AssertRead(await Query(home, thread, ["read"]), atThreshold);

    string aboveThreshold = await Query(home, thread, ["patch"], stdin: PatchHeader + "@@ -1 +1 @@\n-Goal\n+Goals\n");
    string aboveThresholdNote = "Goals\n" + noticeBody;
    AssertSaved(aboveThreshold, thread, aboveThresholdNote);
    AssertRead(await Query(home, thread, ["read"]), aboveThresholdNote);

    string body = new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Multibyte)) + Multibyte;
    string atLimit = Heading + body;
    AssertSaved(await Query(home, thread, ["write"], stdin: atLimit + "\r\n"), thread, atLimit);
    AssertRead(await Query(home, thread, ["read"]), atLimit);

    string patched = await Query(home, thread, ["patch"], stdin: PatchHeader + "@@ -1 +1 @@\n-Goal\n+Next\n");
    string patchedAtLimit = "Next\n" + body;
    AssertSaved(patched, thread, patchedAtLimit);
    AssertRead(await Query(home, thread, ["read"]), patchedAtLimit);

    string prefix = Heading + new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Marker) - 1);
    string saved = prefix + Marker;
    string written = await Query(home, thread, ["write"], stdin: prefix + Multibyte + new string('x', 70_000));
    AssertSaved(written, thread, saved, truncated: true);
    Require(Encoding.UTF8.GetByteCount(saved) == Limit - 1, "The fixture did not cross the limit inside a UTF-8 character.");
    AssertRead(await Query(home, thread, ["read"]), saved);

    const string FirstHunk = "@@ -1 +1 @@\n-Goal\n+Edit\n";
    const string FailurePrefix = "Failed [invalid_input]: ";
    foreach (string rejected in new[]
    {
        PatchHeader + FirstHunk + "@@ -4 +4 @@\n-Wrong old line\n+Ignored\n",
        PatchHeader + "@@ -1 +1 @@\n-Goal\n+Goal \u754c\n",
    })
    {
        CliResult error = await Invoke(home, thread, ["patch"], rejected);
        string failure = error.Stderr.TrimEnd('\r', '\n');
        Require(error.ExitCode == 1 && error.Stdout.Length == 0 && !failure.Contains('\n') &&
            failure.StartsWith(FailurePrefix, StringComparison.Ordinal) && failure.Length > FailurePrefix.Length,
            "An invalid patch did not return a single plain-text error with a reason on stderr.");
        AssertRead(await Query(home, thread, ["read"]), saved);
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

static void AssertRead(string result, string expected) =>
    Require(result == expected, "The read did not return exactly the selected thread's saved Markdown.");

static string AssertSaved(string result, string thread, string expected, bool truncated = false)
{
    using var lines = new StringReader(result);
    int expectedBytes = Encoding.UTF8.GetByteCount(expected);
    Require(lines.ReadLine() == FormattableString.Invariant($"Saved {expectedBytes:N0} UTF-8 bytes."),
        "The receipt must start with the saved Markdown's UTF-8 byte count.");
    if (expectedBytes > NoticeThreshold)
        Require(lines.ReadLine() == "Keep notes concise and under 15 KiB. The recommended maximum is 20 KiB.",
            "The second line must give the expected size recommendation above 15 KiB.");
    Require(lines.ReadLine() == $"Thread: {thread}", "The receipt did not report the expected thread.");

    const string UpdatedPrefix = "Updated: ";
    string update = lines.ReadLine() ?? "";
    Require(update.StartsWith(UpdatedPrefix, StringComparison.Ordinal), "The receipt did not report the update time.");
    string timestamp = update[UpdatedPrefix.Length..];
    Require(DateTimeOffset.TryParseExact(timestamp, "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", CultureInfo.InvariantCulture,
        DateTimeStyles.AssumeUniversal, out _),
        "The receipt did not report a UTC timestamp.");
    if (truncated)
        Require(lines.ReadLine() == "The note was truncated to the save limit.", "The receipt did not report truncation.");
    Require(lines.ReadLine() is null, "The receipt contains unexpected lines.");
    return timestamp;
}

async Task<string> Query(string home, string thread, string[] arguments, string? stdin = null)
{
    CliResult result = await Invoke(home, thread, arguments, stdin);
    Require(result.ExitCode == 0 && result.Stderr.Length == 0, $"memory {string.Join(' ', arguments)} failed with exit {result.ExitCode}.");
    return result.Stdout;
}

async Task<CliResult> Invoke(string home, string thread, string[] arguments, string? stdin)
{
    var utf8 = new UTF8Encoding(false, true);
    var start = new ProcessStartInfo(cli)
    {
        WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        StandardInputEncoding = utf8, StandardErrorEncoding = utf8,
    };
    start.ArgumentList.Add("memory");
    foreach (string argument in arguments)
        start.ArgumentList.Add(argument);
    start.Environment["CODEX_HOME"] = home;
    start.Environment["CODEX_SQLITE_HOME"] = home;
    start.Environment["CODEX_THREAD_ID"] = thread;
    using var process = Process.Start(start) ?? throw new InvalidOperationException("The CLI did not start.");
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    using var stdout = new MemoryStream();
    Task readStdout = process.StandardOutput.BaseStream.CopyToAsync(stdout);
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
    await readStdout;
    return new CliResult(process.ExitCode, utf8.GetString(stdout.GetBuffer().AsSpan(0, (int)stdout.Length)), await stderr);
}

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static string PackagedCli([CallerFilePath] string source = "") =>
    Path.Combine(Path.GetDirectoryName(source)!, "..", "bin", "Thread-Memory.exe");

sealed record CliResult(int ExitCode, string Stdout, string Stderr);
