using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

if (args.Length > 2)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-hook.cs -- [Thread-Memory.exe] [Thread-Memory-Hook.exe]");
    return 2;
}

string cli = FindExecutable(args.ElementAtOrDefault(0), "THREAD_MEMORY_TEST_CLI_EXE", "Thread-Memory.exe");
string hook = FindExecutable(args.ElementAtOrDefault(1), "THREAD_MEMORY_TEST_HOOK_EXE", "Thread-Memory-Hook.exe");
if (!File.Exists(cli) || !File.Exists(hook))
{
    Console.Error.WriteLine("Build the CLI and Hook executables or pass their paths.");
    return 2;
}

const string MaintenanceOpen = "<thread_memory_maintenance>\n";
const string MaintenanceClose = "\n</thread_memory_maintenance>";
const string Duplicate = "may be a duplicate reminder";
const string Model = "fixture-model";
string sandbox = Directory.CreateTempSubdirectory("thread-memory-hook-").FullName;
int passed = 0;
string currentScenario = "initialize verification";

try
{
    await Check("main startup, compaction, and a silent fork snapshot", MainLifecycle);
    await Check("compaction recovery is queued and claimed once by its owning child", ChildLifecycle);
    await Check("65% and 80% reminders run at 45K, 35K, and 25K", ReminderCheckpoints);
    await Check("copied forks require a thread-owned reminder boundary", CopiedForkReminderBoundary);
    await Check("observed delivery and compaction diagnostics survive rollout deletion", DurableDiagnostics);
    await Check("malformed Hook input returns structured stderr", MalformedInput);
    Console.WriteLine($"Passed {passed} Hook scenarios.");
    return 0;
}
catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException
    or JsonException or KeyNotFoundException or TimeoutException)
{
    Console.Error.WriteLine($"Failed {currentScenario}: {error.Message}");
    return 1;
}
finally
{
    Directory.Delete(sandbox, recursive: true);
}

async Task Check(string scenario, Func<string, Task> verify)
{
    currentScenario = scenario;
    string home = Directory.CreateDirectory(Path.Combine(sandbox, $"Codex \u6d4b\u8bd5 {passed}")).FullName;
    Directory.CreateDirectory(Path.Combine(home, "sessions"));
    await verify(home);
    ++passed;
    Console.WriteLine($"Passed {scenario}.");
}

async Task MainLifecycle(string home)
{
    HookRequest root = Root(home);
    string maintenance = Maintenance(await Fire(home, root with { Source = "startup" }));
    Checkpoint(root);
    string recovery = Recovery(await Fire(home, root with { Source = "compact" }), maintenance);
    Require(recovery.Contains("Search the rollout", StringComparison.Ordinal), "Empty-note recovery omitted rollout search.");

    const string note = "A saved decision for the next window \u7ebf\u7a0b";
    await Query(home, ["memory", "write", "--thread", root.SessionId], note);
    string forkedAt = DateTimeOffset.UtcNow.ToString("O");
    await Query(home, ["memory", "write", "--thread", root.SessionId], "Parent's later edit");
    HookRequest fork = Root(home, root.SessionId, forkedAt);
    Require(await Fire(home, fork with { Source = "fork" }) is null, "A main-thread fork emitted startup guidance.");
    string read = await Query(home, ["memory", "read", "--thread", fork.SessionId]);
    Require(read == note, "The fork did not copy the note as of fork time.");

    Checkpoint(fork);
    recovery = Recovery(await Fire(home, fork with { Source = "compact" }), maintenance);
    Require(recovery.Contains("memory read", StringComparison.Ordinal) && !recovery.Contains(note, StringComparison.Ordinal),
        "Saved-note recovery must direct the Agent to the note without inlining it.");
    JsonElement diagnostic = (await Events(home, fork.SessionId)).Single(item => Event(item) == "compact_context_prepared");
    Require(diagnostic.GetProperty("details").GetProperty("note_status").GetString() == "available",
        "Compaction diagnostics did not record the saved note's availability.");
}

async Task ChildLifecycle(string home)
{
    HookRequest root = Root(home);
    await Query(home, ["memory", "write", "--thread", root.SessionId], "Parent-only note");
    HookRequest child = Child(home, root.SessionId, fork: true);
    HookRequest sibling = Child(home, root.SessionId, fork: false);
    string maintenance = Maintenance(await Fire(home, child));
    string note = await Query(home, ["memory", "read", "--thread", child.AgentId!]);
    Require(note.Length == 0,
        "A subagent with inherited history also inherited the parent note.");
    Require(await Fire(home, child with { HookEventName = "SessionStart", AgentId = null, Source = "compact" }) is null,
        "SessionStart used the child's transcript for the parent.");

    HookRequest compact = child with { HookEventName = "PostCompact", Trigger = "auto" };
    HookRequest tool = child with { HookEventName = "PostToolUse", ToolUseId = "after_compact" };
    Require(await Fire(home, tool) is null, "A child received recovery before compaction.");
    Checkpoint(child);
    Require(await Fire(home, compact) is null, "PostCompact emitted context instead of queuing recovery.");
    Require(await Fire(home, tool with { AgentId = sibling.AgentId }) is null, "A mismatched child claimed recovery.");
    Require(await Fire(home, root with { HookEventName = "PostToolUse" }) is null, "The parent claimed child recovery.");
    Require(await Fire(home, sibling with { HookEventName = "PostToolUse" }) is null, "A sibling claimed child recovery.");

    string?[] results = await Task.WhenAll(Fire(home, tool), Fire(home, tool with { ToolUseId = "parallel_tool" }));
    string recovery = Recovery(results.Single(context => context is not null), maintenance);
    Require(recovery.Contains("memory read", StringComparison.Ordinal) && recovery.Contains("Search the rollout", StringComparison.Ordinal),
        "A child recovery prompt omitted note or rollout guidance.");
    Require(await Fire(home, tool) is null, "A later child tool received recovery again.");
    var events = await Events(home, child.AgentId!);
    Require(events.Count(item => Event(item) == "subagent_recovery_context_prepared") == 1,
        "Diagnostics did not record exactly one child recovery.");
}

async Task ReminderCheckpoints(string home)
{
    File.WriteAllText(Path.Combine(home, "config.toml"),
        "model_context_window = 500000\n[features.async_compaction]\nenabled = true\n");
    File.WriteAllText(Path.Combine(home, "models_cache.json"), new JsonObject
    {
        ["models"] = new JsonArray(new JsonObject
        {
            ["slug"] = Model, ["context_window"] = 500_000, ["effective_context_window_percent"] = 100,
        }),
    }.ToJsonString());
    HookRequest request = StartTurn(Child(home, Root(home).SessionId, fork: false));
    Require(await Use(279_999) is null, "A reminder arrived before the 65% first threshold.");
    string first = Reminder(await Use(280_000), 65, duplicate: false);
    Append(request, "response_item", Message("user", first));
    Require(await Use(289_999) is null, "A follow-up arrived before the first check.");
    const int FirstCheck = 290_000;
    Usage(request, FirstCheck);
    string?[] results = await Task.WhenAll(Fire(home, request), Fire(home, request with { ToolUseId = "parallel_check" }));
    string retry = Reminder(results.Single(context => context is not null), 65, duplicate: true);
    Require(NotifyId(first) == NotifyId(retry), "A follow-up changed the active window's Notify ID.");
    Require(await Use(299_999) is null, "A final follow-up arrived before the final check.");
    string final = Reminder(await Use(300_000), 65, duplicate: true);
    Require(NotifyId(first) == NotifyId(final), "The final follow-up changed the active window's Notify ID.");
    Require(await Fire(home, request) is null, "An already-claimed check emitted a reminder again.");

    Require(await Use(354_999) is null, "A reminder arrived before the 80% first threshold.");
    string secondTier = Reminder(await Use(355_000), 80, duplicate: false);
    RecordDelivery(request, secondTier, "2026-01-01T00:00:01Z");
    Require(await Use(365_000) is null, "A receipt-confirmed reminder was sent again at the first check.");
    Require(await Use(375_000) is null, "A receipt-confirmed reminder was sent again at the final check.");
    JsonElement confirmed = (await Events(home, request.AgentId!)).Single(item => Event(item) == "reminder_receipt_observed");
    JsonElement details = confirmed.GetProperty("details");
    Require(details.GetProperty("used").GetInt32() == 365_000 && details.GetProperty("capacity").GetInt32() == 500_000 &&
        details.GetProperty("leads").EnumerateArray().Select(item => item.GetInt32()).SequenceEqual([45_000, 35_000, 25_000]),
        "Receipt diagnostics did not preserve the observed usage and effective reminder schedule.");

    Checkpoint(request);
    string next = Reminder(await Use(280_000), 65, duplicate: false);
    Require(NotifyId(first) != NotifyId(next), "A new compaction window reused the previous Notify ID.");

    Task<string?> Use(int tokens)
    {
        Usage(request, tokens);
        return Fire(home, request);
    }
}

async Task CopiedForkReminderBoundary(string home)
{
    const string Startup = "350000";
    const int NearThreshold = 305_000;
    HookRequest parent = Root(home);
    HookRequest fork = Root(home, parent.SessionId, "2026-01-01T00:00:01Z");
    Settings(parent.SessionId);
    Checkpoint(fork);
    HookRequest inheritedTurn = StartTurn(fork);
    Usage(inheritedTurn, NearThreshold);
    Settings(fork.SessionId);
    Require(await Fire(home, inheritedTurn, Startup) is null,
        "A copied compaction and usage sample enabled reminders for the fork.");

    long copiedLength = new FileInfo(fork.TranscriptPath).Length;
    Checkpoint(fork);
    HookRequest ownTurn = StartTurn(fork);
    Usage(ownTurn, NearThreshold);
    string first = Reminder(await Fire(home, ownTurn, Startup), 0, duplicate: false);
    Usage(ownTurn, NearThreshold + 10_000);
    var followup = Reminder(await Fire(home, ownTurn, Startup), 0, duplicate: true);
    Require(NotifyId(first) == NotifyId(followup), "Appending usage lost the verified owned window.");

    // Force the 4 MiB recovery probe to scan a bounded tail without the owned settings or cursor offset.
    Append(fork, "response_item", Message("assistant", new string('x', 4 * 1024 * 1024)));
    const string LaterCompaction = "2026-01-01T00:00:02Z";
    Checkpoint(fork, LaterCompaction);
    await Fire(home, fork with { Source = "compact" });
    Require((await Events(home, fork.SessionId)).Any(item => Event(item) == "compaction_checkpoint_observed" &&
        item.GetProperty("details").GetProperty("compacted_at").GetString() == LaterCompaction),
        "The bounded recovery scan lost the verified ancestry of the next compaction.");

    Append(fork, "event_msg", new JsonObject { ["type"] = "thread_rolled_back", ["num_turns"] = 1 });
    HookRequest rolledBackTurn = StartTurn(fork);
    Usage(rolledBackTurn, NearThreshold);
    string afterRollback = Reminder(await Fire(home, rolledBackTurn, Startup), 0, duplicate: false);
    Require(NotifyId(first) != NotifyId(afterRollback), "A rollback reused an earlier window's reminder.");

    using (var stream = File.Open(fork.TranscriptPath, FileMode.Open, FileAccess.Write))
        stream.SetLength(copiedLength);
    Require(await Fire(home, inheritedTurn, Startup) is null,
        "A discarded checkpoint enabled reminders from copied history after truncation.");

    void Settings(string owner) => Append(fork, "event_msg", new JsonObject
    {
        ["type"] = "thread_settings_applied", ["thread_id"] = owner,
        ["thread_settings"] = new JsonObject { ["model"] = Model },
    });
}

async Task DurableDiagnostics(string home)
{
    HookRequest root = Root(home);
    HookRequest request = StartTurn(root);
    Usage(request, 305_000);
    string first = Reminder(await Fire(home, request, startup: "350000"), 0, duplicate: false);
    Usage(request, 315_000);
    string followup = Reminder(await Fire(home, request, startup: "350000"), 0, duplicate: true);
    RecordDelivery(request, first, "2026-01-01T00:00:01Z");
    Usage(request, 320_000);
    Require(await Fire(home, request, startup: "350000") is null, "Codex had already recorded the first prompt.");

    const string CompactedAt = "2026-01-01T00:00:02Z";
    const string DuplicateAt = "2026-01-01T00:00:03Z";
    Checkpoint(root, CompactedAt);
    RecordDelivery(request, followup, DuplicateAt);
    await Fire(home, root with { Source = "compact" });
    File.Delete(root.TranscriptPath);

    JsonElement[] events = await Events(home, root.SessionId);
    JsonElement[] deliveries = events.Where(item => Event(item) == "reminder_rollout_observed").ToArray();
    Require(deliveries.Length == 2, "The available rollout no longer accounts for two observed deliveries.");
    JsonElement late = deliveries[0].GetProperty("details");
    Require(late.GetProperty("duplicate").GetBoolean() && late.GetProperty("recorded_at").GetString() == DuplicateAt,
        "The duplicate delivery timestamp was lost.");
    JsonElement checkpoint = events.Single(item => Event(item) == "compaction_checkpoint_observed").GetProperty("details");
    string? priorWindow = events.First(item => Event(item) == "reminder_context_prepared").GetProperty("window").GetString();
    Require(checkpoint.GetProperty("compacted_at").GetString() == CompactedAt &&
        checkpoint.GetProperty("previous_window").GetString() == priorWindow,
        $"Compaction lost its timestamp or prior window. Expected {CompactedAt} and {priorWindow}, got {checkpoint}.");

    var summary = Parse(await Query(home, ["diagnostics", "--summary"]));
    Dictionary<string, int> metrics = summary.GetProperty("items").EnumerateArray().ToDictionary(
        item => item.GetProperty("metric").GetString()!, item => item.GetProperty("count").GetInt32());
    Require(metrics.Count == 5 && metrics.GetValueOrDefault("first") == 1 && metrics.GetValueOrDefault("followup_1") == 1 &&
        metrics.GetValueOrDefault("receipt_confirmed") == 1 && metrics.GetValueOrDefault("delivery_observed") == 2 &&
        metrics.GetValueOrDefault("duplicate_observed") == 1, "The diagnostic summary lost its reminder counts.");
}

async Task MalformedInput(string home)
{
    ProcessResult result = await Run(home, hook, [], "{");
    Require(result.ExitCode == 1 && result.Output.Length == 0, "Malformed Hook input did not fail with empty stdout.");
    Require(Parse(result.Error).GetProperty("error").GetProperty("code").GetString() == "invalid_input",
        "Malformed Hook input did not report an invalid_input JSON error.");
}

HookRequest Root(string home, string? parent = null, string? timestamp = null)
{
    string id = Guid.NewGuid().ToString();
    var request = new HookRequest("SessionStart", id, RolloutPath(home, id));
    var header = new JsonObject { ["id"] = id, ["session_id"] = id, ["source"] = "vscode", ["thread_source"] = "user" };
    if (parent is not null)
    {
        header["forked_from_id"] = parent;
        header["timestamp"] = timestamp;
    }
    Append(request, "session_meta", header);
    return request;
}

HookRequest Child(string home, string parent, bool fork)
{
    string id = Guid.NewGuid().ToString();
    var request = new HookRequest("SubagentStart", parent, RolloutPath(home, id), AgentId: id, AgentType: "worker");
    var header = new JsonObject
    {
        ["id"] = id, ["session_id"] = parent, ["thread_source"] = "subagent",
        ["source"] = new JsonObject
        {
            ["subagent"] = new JsonObject
            {
                ["thread_spawn"] = new JsonObject { ["parent_thread_id"] = parent, ["depth"] = 1 },
            },
        },
    };
    if (fork)
    {
        header["forked_from_id"] = parent;
        header["timestamp"] = DateTimeOffset.UtcNow.ToString("O");
    }
    Append(request, "session_meta", header);
    return request;
}

HookRequest StartTurn(HookRequest request)
{
    string turn = Guid.NewGuid().ToString();
    Append(request, "event_msg", new JsonObject
    {
        ["type"] = "task_started", ["turn_id"] = turn, ["model_context_window"] = 500_000,
    });
    Append(request, "turn_context", new JsonObject { ["turn_id"] = turn, ["model"] = Model });
    return request with { HookEventName = "PostToolUse", Model = Model, TurnId = turn, ToolUseId = "tool" };
}

void Usage(HookRequest request, int tokens) => Append(request, "event_msg", new JsonObject
{
    ["type"] = "token_count",
    ["info"] = new JsonObject
    {
        ["last_token_usage"] = new JsonObject { ["total_tokens"] = tokens }, ["model_context_window"] = 500_000,
    },
});

static JsonObject Message(string role, string text) => new()
{
    ["type"] = "message", ["role"] = role,
    ["content"] = new JsonArray(new JsonObject { ["type"] = "input_text", ["text"] = text }),
};

void RecordDelivery(HookRequest request, string context, string timestamp)
{
    JsonObject message = Message("developer", context);
    message["internal_chat_message_metadata_passthrough"] = new JsonObject
    {
        ["content_item_kinds"] = new JsonArray(JsonValue.Create("hooks.additional_context")),
        ["content_item_metadata"] = new JsonArray(new JsonObject
        {
            ["provenance"] = new JsonObject { ["type"] = "harness", ["hook"] = true },
        }),
    };
    Append(request, "response_item", message, timestamp);
}

void Checkpoint(HookRequest request, string? timestamp = null) =>
    Append(request, "compacted", new JsonObject { ["replacement_history"] = new JsonArray() }, timestamp);

static void Append(HookRequest request, string type, JsonObject payload, string? timestamp = null)
{
    var record = new JsonObject();
    if (timestamp is not null)
        record["timestamp"] = timestamp;
    record["type"] = type;
    record["payload"] = payload;
    File.AppendAllText(request.TranscriptPath, record.ToJsonString() + '\n');
}

static string RolloutPath(string home, string id) => Path.Combine(home, "sessions", $"rollout-2026-01-01T00-00-00-{id}.jsonl");

static string Maintenance(string? context)
{
    Require(context is not null && context.StartsWith(MaintenanceOpen, StringComparison.Ordinal) &&
        context.EndsWith(MaintenanceClose, StringComparison.Ordinal) && context.Contains("$thread-memory", StringComparison.Ordinal),
        "The Hook did not return tagged maintenance guidance.");
    return context!;
}

static string Recovery(string? context, string maintenance)
{
    const string Open = "<thread_memory_recovery>\n";
    string suffix = $"\n</thread_memory_recovery>\n\n{maintenance}";
    Require(context is not null && context.StartsWith(Open, StringComparison.Ordinal) && context.EndsWith(suffix, StringComparison.Ordinal),
        "Compaction recovery did not put the same startup guidance last.");
    return context![Open.Length..^suffix.Length];
}

static string Reminder(string? context, int tier, bool duplicate)
{
    Require(context is not null && context.StartsWith("<thread_memory_reminder>\n", StringComparison.Ordinal) &&
        Regex.IsMatch(context, $@"\nNotify ID: \[{tier}:[A-Za-z0-9_-]{{8}}\]\n</thread_memory_reminder>\z"),
        $"Expected a tagged reminder for tier {tier}.");
    Require(context!.Contains(Duplicate, StringComparison.Ordinal) == duplicate,
        "The reminder's follow-up wording did not match the stage.");
    return context;
}

static string NotifyId(string reminder) => Regex.Match(reminder, @"Notify ID: \[\d+:([A-Za-z0-9_-]{8})\]").Groups[1].Value;

async Task<string?> Fire(string home, HookRequest request, string? startup = null)
{
    var payload = new JsonObject
    {
        ["hook_event_name"] = request.HookEventName, ["session_id"] = request.SessionId,
        ["transcript_path"] = request.TranscriptPath,
    };
    foreach (var (name, value) in new[]
    {
        ("source", request.Source), ("agent_id", request.AgentId), ("agent_type", request.AgentType),
        ("trigger", request.Trigger), ("model", request.Model), ("turn_id", request.TurnId), ("tool_use_id", request.ToolUseId),
    })
    {
        if (value is not null)
            payload[name] = value;
    }
    ProcessResult result = await Run(home, hook, [], payload.ToJsonString(), startup);
    Require(result.ExitCode == 0 && result.Error.Length == 0, $"{request.HookEventName} failed ({result.ExitCode}): {result.Error}");
    if (result.Output.Length == 0)
        return null;
    JsonElement output = Parse(result.Output).GetProperty("hookSpecificOutput");
    Require(output.GetProperty("hookEventName").GetString() == request.HookEventName, "Hook output named the wrong event.");
    return output.GetProperty("additionalContext").GetString();
}

async Task<JsonElement[]> Events(string home, string thread) =>
    Parse(await Query(home, ["diagnostics", "--thread", thread])).GetProperty("items").EnumerateArray().ToArray();

static string? Event(JsonElement item) => item.GetProperty("event").GetString();

async Task<string> Query(string home, string[] arguments, string? input = null)
{
    ProcessResult result = await Run(home, cli, arguments, input);
    Require(result.ExitCode == 0 && result.Error.Length == 0, $"{arguments[0]} failed ({result.ExitCode}): {result.Error}");
    return result.Output;
}

static JsonElement Parse(string json)
{
    using var document = JsonDocument.Parse(json);
    return document.RootElement.Clone();
}

static async Task<ProcessResult> Run(string home, string path, string[] arguments, string? input, string? startup = null)
{
    var start = new ProcessStartInfo(path)
    {
        WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
        StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
    };
    start.Environment["CODEX_HOME"] = home;
    start.Environment["CODEX_SQLITE_HOME"] = home;
    start.Environment.Remove("CODEX_THREAD_ID");
    start.Environment.Remove("THREAD_MEMORY_ASYNC_START_TOKENS");
    start.Environment.Remove("THREAD_MEMORY_HANDOFF_LEAD_TOKENS");
    if (startup is not null)
        start.Environment["THREAD_MEMORY_ASYNC_START_TOKENS"] = startup;
    foreach (string argument in arguments)
        start.ArgumentList.Add(argument);

    using var process = Process.Start(start) ?? throw new InvalidOperationException("The executable did not start.");
    Task<string> output = process.StandardOutput.ReadToEndAsync();
    Task<string> error = process.StandardError.ReadToEndAsync();
    if (input is not null)
        await process.StandardInput.WriteAsync(input);
    process.StandardInput.Close();
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    try
    {
        await process.WaitForExitAsync(timeout.Token);
    }
    catch (OperationCanceledException) when (timeout.IsCancellationRequested)
    {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
        throw new TimeoutException($"{Path.GetFileName(path)} exceeded the test timeout.");
    }
    return new ProcessResult(process.ExitCode, await output, await error);
}

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static string FindExecutable(string? path, string variable, string name, [CallerFilePath] string source = "") =>
    Path.GetFullPath(path ?? Environment.GetEnvironmentVariable(variable) ?? Path.Combine(Path.GetDirectoryName(source)!, "..", "bin", name));

sealed record HookRequest(string HookEventName, string SessionId, string TranscriptPath, string? Source = null,
    string? AgentId = null, string? AgentType = null, string? Trigger = null, string? Model = null,
    string? TurnId = null, string? ToolUseId = null);

sealed record ProcessResult(int ExitCode, string Output, string Error);
