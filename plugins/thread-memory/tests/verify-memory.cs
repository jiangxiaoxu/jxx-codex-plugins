using System.Diagnostics;
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

const int Limit = 32 * 1024;
const int NoticeThreshold = 20 * 1024;
const int WritingLimitKiB = 26;
string sandbox = Directory.CreateTempSubdirectory("thread-memory-note-").FullName;
string scenario = "UTF-8 notes, CLI thread selection, and lazy fork isolation";

try
{
    await VerifyFork(NewHome("fork"));
    Console.WriteLine($"Passed {scenario}.");
    scenario = "UTF-8 note limits and rejection of empty writes";
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
    AssertSaved(first, Original);
    AssertRead(await Query(home, parent, ["read"]), Original);

    string child = MakeRollout(home, parent, DateTime.UtcNow.ToString("O"));
    const string NewerParent = "Goal\nParent after fork\nNext";
    AssertSaved(await Query(home, parent, ["write"], stdin: NewerParent), NewerParent);
    AssertRead(await Query(home, parent, ["--thread", child, "read"]), Original);

    const string ChildLine = "\u5b50\u7ebf\u7a0b \U0001f680";
    const string ChildNote = $"Goal\n{ChildLine}\nReview";
    AssertSaved(await Query(home, parent, ["write", "--thread", child], stdin: ChildNote), ChildNote);
    AssertRead(await Query(home, child, ["read"]), ChildNote);
    AssertRead(await Query(home, parent, ["read"]), NewerParent);
}

async Task VerifyBounds(string home)
{
    string thread = MakeRollout(home);
    const string Marker = "\n\n[Summary truncated]";
    const string Heading = "Goal\n";
    const string Multibyte = "\u754c";

    string noticeBody = new string('x', NoticeThreshold - Encoding.UTF8.GetByteCount(Heading + Multibyte));
    string atThreshold = Heading + noticeBody + Multibyte;
    AssertSaved(await Query(home, thread, ["write"], stdin: atThreshold), atThreshold);
    AssertRead(await Query(home, thread, ["read"]), atThreshold);

    string aboveThresholdNote = atThreshold + "x";
    AssertSaved(await Query(home, thread, ["write"], stdin: aboveThresholdNote), aboveThresholdNote);
    AssertRead(await Query(home, thread, ["read"]), aboveThresholdNote);

    string body = new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Multibyte)) + Multibyte;
    string atLimit = Heading + body;
    AssertSaved(await Query(home, thread, ["write"], stdin: atLimit + "\r\n"), atLimit);
    AssertRead(await Query(home, thread, ["read"]), atLimit);

    string prefix = Heading + new string('x', Limit - Encoding.UTF8.GetByteCount(Heading + Marker) - 1);
    string saved = prefix + Marker;
    string written = await Query(home, thread, ["write"], stdin: prefix + Multibyte + new string('x', 70_000));
    AssertSaved(written, saved, truncated: true);
    Require(Encoding.UTF8.GetByteCount(saved) == Limit - 1, "The fixture did not cross the limit inside a UTF-8 character.");
    AssertRead(await Query(home, thread, ["read"]), saved);

    const string FailurePrefix = "Failed [invalid_input]: ";
    CliResult error = await Invoke(home, thread, ["write"], "\r\n \t\r\n");
    string failure = error.Stderr.TrimEnd('\r', '\n');
    Require(error.ExitCode == 1 && error.Stdout.Length == 0 && !failure.Contains('\n') &&
        failure.StartsWith(FailurePrefix, StringComparison.Ordinal) && failure.Length > FailurePrefix.Length,
        "An empty write did not return a single plain-text error with a reason on stderr.");
    AssertRead(await Query(home, thread, ["read"]), saved);
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

static void AssertSaved(string result, string expected, bool truncated = false)
{
    using var lines = new StringReader(result);
    int expectedBytes = Encoding.UTF8.GetByteCount(expected);
    Require(lines.ReadLine() == FormattableString.Invariant($"Note saved. Total size: {expectedBytes:N0} UTF-8 bytes."),
        "The receipt must start with the complete saved Markdown's UTF-8 byte count.");
    if (expectedBytes > NoticeThreshold)
        Require(lines.ReadLine() is { } notice && notice.Contains($"{NoticeThreshold / 1024} KiB", StringComparison.Ordinal)
            && notice.Contains($"{WritingLimitKiB} KiB", StringComparison.Ordinal),
            "The receipt omitted the note size guidance above the notice threshold.");
    if (truncated)
        Require(lines.ReadLine() == "The note was truncated to the save limit.", "The receipt did not report truncation.");
    Require(lines.ReadLine() is null, "The receipt contains unexpected lines.");
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
