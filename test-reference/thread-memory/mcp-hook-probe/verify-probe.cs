using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

if (args is not [var probe, var commandHook])
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-probe.cs -- PROBE_EXE COMMAND_HOOK_EXE");
    return 2;
}

string home = Directory.CreateTempSubdirectory("tm-hook-probe-").FullName;
try
{
    string session = Guid.NewGuid().ToString();
    string agent = Guid.NewGuid().ToString();
    string main = Fixture(session, session);
    string child = Fixture(agent, session);
    var cold = Stopwatch.StartNew();
    await using var connection = new ProbeClient(probe, home);
    await connection.Request("initialize", new() { ["protocolVersion"] = "2025-11-25" });
    await connection.Notify("notifications/initialized");
    var tools = await connection.Request("tools/list");
    Assert(tools["tools"]?[0]?["name"]?.GetValue<string>() == "thread_memory_hook", "Missing Hook in MCP tools/list.");
    var mainStartup = Payload("SessionStart", session, main, source: "startup");
    string startup = Context(await connection.Hook(mainStartup), "SessionStart");
    cold.Stop();
    Assert(startup.Contains("<thread_memory_maintenance>", StringComparison.Ordinal), "Startup lost maintenance guidance.");

    string recovery = Context(await connection.Hook(Payload("SessionStart", session, main, source: "compact")), "SessionStart");
    Assert(recovery.EndsWith(startup, StringComparison.Ordinal), "Post-compaction SessionStart lost maintenance guidance.");
    Assert((await connection.Hook(Payload("SessionStart", session, main, source: "fork"))).AsArray().Count == 0,
        "Fork should be silent.");
    string subagentStart = Context(await connection.Hook(Payload("SubagentStart", session, child, agent: agent)), "SubagentStart");
    Assert(subagentStart == startup, "Subagent startup changed the shared instruction.");
    Assert((await connection.Hook(Payload("PostCompact", session, main))).AsArray().Count == 0, "Main PostCompact should be silent.");

    var postToolInput = Payload("PostToolUse", session, child, agent: agent);
    await connection.Hook(Payload("PostCompact", Guid.NewGuid().ToString(), child));
    Assert(await Command(postToolInput) == "", "Compaction from a mismatched session queued child recovery.");
    var childCompaction = await connection.Hook(Payload("PostCompact", session, child));
    Assert(childCompaction.AsArray().Count == 0, "Child PostCompact should be silent.");
    var childRecovery = JsonNode.Parse(await Command(postToolInput))?["hookSpecificOutput"]?["additionalContext"]?.GetValue<string>();
    Assert(childRecovery?.Contains("<thread_memory_recovery>", StringComparison.Ordinal) == true,
        "The existing command PostToolUse did not recover the pending child compaction.");
    Assert(await Command(postToolInput) == "", "The pending child compaction was consumed twice.");
    Console.WriteLine("Passed MCP lifecycle and command interoperability.");

    var warmSamples = new List<double>();
    var commandSamples = new List<double>();
    for (int i = 0; i < 30; ++i)
    {
        var elapsed = Stopwatch.StartNew();
        await connection.Hook(mainStartup.DeepClone().AsObject());
        warmSamples.Add(elapsed.Elapsed.TotalMilliseconds);
        elapsed.Restart();
        await Command(mainStartup);
        commandSamples.Add(elapsed.Elapsed.TotalMilliseconds);
    }
    Console.WriteLine($"Cold MCP (initialize, list, first hook): {cold.Elapsed.TotalMilliseconds:F2} ms.");
    Console.WriteLine($"Warm MCP hook: {Statistics(warmSamples)}. New command process (direct, without PowerShell): {Statistics(commandSamples)}.");
    return 0;
}
catch (Exception error) when (error is IOException or InvalidOperationException or TimeoutException)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}
finally
{
    Directory.Delete(home, recursive: true);
}

string Fixture(string id, string session)
{
    string path = Path.Combine(Directory.CreateDirectory(Path.Combine(home, "sessions")).FullName, $"rollout-{id}.jsonl");
    JsonNode source = JsonValue.Create("cli")!;
    if (id != session)
        source = new JsonObject
        {
            ["subagent"] = new JsonObject
            {
                ["thread_spawn"] = new JsonObject { ["parent_thread_id"] = session, ["depth"] = 1 },
            },
        };
    var line = new JsonObject
    {
        ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"),
        ["type"] = "session_meta",
        ["payload"] = new JsonObject { ["id"] = id, ["session_id"] = session, ["source"] = source },
    };
    File.WriteAllText(path, line.ToJsonString() + "\n");
    return path;
}

async Task<string> Command(JsonObject request)
{
    using Process process = ProbeClient.Start(commandHook, home);
    var stdout = process.StandardOutput.ReadToEndAsync();
    var stderr = process.StandardError.ReadToEndAsync();
    await process.StandardInput.WriteLineAsync(request.ToJsonString());
    process.StandardInput.Close();
    await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    if (process.ExitCode != 0)
        throw new InvalidOperationException($"Command Hook exited {process.ExitCode}: {await stderr}");
    return await stdout;
}

static string Context(JsonNode blocks, string expectedEvent)
{
    Assert(blocks.AsArray().Count == 1 && blocks[0]?["type"]?.GetValue<string>() == "text", "Expected one MCP text result.");
    var output = JsonNode.Parse(blocks[0]!["text"]!.GetValue<string>())?["hookSpecificOutput"];
    Assert(output?["hookEventName"]?.GetValue<string>() == expectedEvent, "Unexpected hook event name.");
    return output?["additionalContext"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing additional context.");
}

static string Statistics(List<double> values)
{
    values.Sort();
    return $"p50 {values[(int)Math.Ceiling(values.Count * 0.50) - 1]:F2} ms, p95 {values[(int)Math.Ceiling(values.Count * 0.95) - 1]:F2} ms, n={values.Count}";
}

static JsonObject Payload(string name, string session, string transcript, string? source = null, string? agent = null)
{
    var value = new JsonObject { ["hook_event_name"] = name, ["session_id"] = session, ["transcript_path"] = transcript };
    if (source is not null)
        value["source"] = source;
    if (agent is not null)
        value["agent_id"] = agent;
    return value;
}

static void Assert(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

file sealed class ProbeClient(string executable, string home) : IAsyncDisposable
{
    private readonly Process process = Start(executable, home);
    private int id;

    public async Task Notify(string method) =>
        await process.StandardInput.WriteLineAsync(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = method }.ToJsonString());

    public async Task<JsonNode> Request(string method, JsonObject? parameters = null)
    {
        var request = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = ++id, ["method"] = method };
        if (parameters is not null)
            request["params"] = parameters;
        await process.StandardInput.WriteLineAsync(request.ToJsonString());
        var raw = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10));
        if (raw is null)
            throw new InvalidOperationException($"MCP Hook exited before replying: {await process.StandardError.ReadToEndAsync()}");
        var reply = JsonNode.Parse(raw);
        if (reply?["id"]?.GetValue<int>() != id || reply?["result"] is not { } result)
            throw new InvalidOperationException($"Unexpected MCP reply: {raw}");
        return result;
    }

    public async Task<JsonNode> Hook(JsonObject value)
    {
        var reply = await Request("tools/call", new() { ["name"] = "thread_memory_hook", ["arguments"] = value });
        return reply["content"] ?? throw new InvalidOperationException("Missing MCP content.");
    }

    public async ValueTask DisposeAsync()
    {
        process.StandardInput.Close();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TimeoutException)
        {
            process.Kill();
            await process.WaitForExitAsync();
        }
        finally
        {
            process.Dispose();
        }
    }

    public static Process Start(string executable, string home)
    {
        var info = new ProcessStartInfo(Path.GetFullPath(executable))
        {
            UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.ArgumentList.Add("--codex-home");
        info.ArgumentList.Add(home);
        return Process.Start(info) ?? throw new InvalidOperationException("Could not start the Native AOT executable.");
    }
}
