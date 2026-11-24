using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using ThreadMemoryHook;

if (args is not ["--codex-home", var home] || !Directory.Exists(home))
{
    Console.Error.WriteLine("Usage: Thread-Memory-Mcp-Hook-Probe --codex-home EXISTING_TEST_DIRECTORY");
    return 2;
}

const string ToolName = "thread_memory_hook";
var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
using var input = new StreamReader(Console.OpenStandardInput(), utf8);
using var output = new StreamWriter(Console.OpenStandardOutput(), utf8) { NewLine = "\n", AutoFlush = true };
while (input.ReadLine() is { } line)
{
    if (Reply(line) is { } reply)
        output.WriteLine(reply.ToJsonString());
}
return 0;

JsonObject? Reply(string line)
{
    var reply = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = null };
    JsonDocument document;
    try
    {
        document = JsonDocument.Parse(line);
    }
    catch (JsonException)
    {
        return Fail(-32700, "Parse error.");
    }

    using (document)
    {
        var request = document.RootElement;
        if (SessionFiles.String(request, "jsonrpc") != "2.0" ||
            SessionFiles.String(request, "method") is not { } method)
            return Fail(-32600, "Invalid request.");
        if (!request.TryGetProperty("id", out var id))
            return null;
        if (id.ValueKind is not (JsonValueKind.String or JsonValueKind.Number or JsonValueKind.Null))
            return Fail(-32600, "Invalid request ID.");
        reply["id"] = JsonNode.Parse(id.GetRawText());
        var parameters = SessionFiles.Property(request, "params");
        if (parameters.ValueKind is not (JsonValueKind.Object or JsonValueKind.Undefined))
            return Fail(-32602, "Expected a parameter object.");

        switch (method)
        {
            case "initialize":
                var version = SessionFiles.String(parameters, "protocolVersion");
                reply["result"] = new JsonObject
                {
                    ["protocolVersion"] = version is "2024-11-05" or "2025-03-26" or "2025-06-18" or "2025-11-25" or "2026-07-28"
                        ? version : "2025-11-25",
                    ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                    ["serverInfo"] = new JsonObject { ["name"] = "thread-memory-hook-probe", ["version"] = "1" },
                };
                break;
            case "ping":
                reply["result"] = new JsonObject();
                break;
            case "tools/list":
                reply["result"] = new JsonObject
                {
                    ["tools"] = new JsonArray(new JsonObject
                    {
                        ["name"] = ToolName,
                        ["description"] = "Run a low-frequency Thread Memory hook in an isolated test home.",
                        ["inputSchema"] = new JsonObject
                        {
                            ["type"] = "object",
                            ["properties"] = new JsonObject
                            {
                                ["hook_event_name"] = new JsonObject
                                {
                                    ["type"] = "string",
                                    ["enum"] = new JsonArray("SessionStart", "SubagentStart", "PostCompact"),
                                },
                                ["session_id"] = new JsonObject { ["type"] = "string" },
                                ["transcript_path"] = new JsonObject { ["type"] = new JsonArray("string", "null") },
                                ["source"] = new JsonObject { ["type"] = "string" },
                                ["agent_id"] = new JsonObject { ["type"] = "string" },
                            },
                            ["required"] = new JsonArray("hook_event_name", "session_id", "transcript_path"),
                        },
                        ["_meta"] = new JsonObject
                        {
                            ["ui"] = new JsonObject { ["visibility"] = new JsonArray("app") },
                        },
                    }),
                };
                break;
            case "tools/call":
                if (SessionFiles.String(parameters, "name") != ToolName)
                    return Fail(-32602, "Unknown tool.");
                var requestArguments = SessionFiles.Property(parameters, "arguments");
                if (SessionFiles.String(requestArguments, "hook_event_name") is not
                    ("SessionStart" or "SubagentStart" or "PostCompact"))
                    return Fail(-32602, "Expected a low-frequency hook event.");
                try
                {
                    reply["result"] = CallHook(requestArguments);
                }
                catch (Exception error) when (error is
                    IOException or UnauthorizedAccessException or JsonException or SqliteException or ArgumentException)
                {
                    return Fail(-32603, "The hook could not read the test state.");
                }
                break;
            default:
                return Fail(-32601, "Method not found.");
        }
    }
    return reply;

    JsonObject Fail(int code, string message)
    {
        reply["error"] = new JsonObject { ["code"] = code, ["message"] = message };
        return reply;
    }
}

JsonObject CallHook(JsonElement request)
{
    var blocks = new JsonArray();
    var result = new JsonObject { ["content"] = blocks };
    var hookEvent = SessionFiles.String(request, "hook_event_name")!;
    string? context;
    if (hookEvent == "PostCompact" && SessionFiles.String(request, "agent_id") is null &&
        SessionFiles.String(request, "transcript_path") is { Length: > 0 } path)
    {
        // Root events omit agent_id; MCP input templates cannot expand optional properties.
        // A child header supplies the value, which HookInstructions verifies against the session.
        JsonElement header;
        try
        {
            header = SessionFiles.ReadHeader(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return result;
        }
        JsonElement source = SessionFiles.Property(header, "source");
        JsonElement spawn = SessionFiles.Property(SessionFiles.Property(source, "subagent"), "thread_spawn");
        if (spawn.ValueKind != JsonValueKind.Object ||
            !Guid.TryParse(SessionFiles.String(request, "session_id"), out var eventSession) ||
            !Guid.TryParse(SessionFiles.String(header, "session_id"), out var rolloutSession) || rolloutSession != eventSession ||
            SessionFiles.String(header, "id") is not { } agentId)
            return result;
        var normalized = JsonNode.Parse(request.GetRawText())!.AsObject();
        normalized["agent_id"] = agentId;
        using var document = JsonDocument.Parse(normalized.ToJsonString());
        context = HookInstructions.Get(document.RootElement, home);
    }
    else
    {
        context = HookInstructions.Get(request, home);
    }

    if (context is not null)
    {
        var commandOutput = new JsonObject
        {
            ["hookSpecificOutput"] = new JsonObject { ["hookEventName"] = hookEvent, ["additionalContext"] = context },
        };
        blocks.Add((JsonNode)new JsonObject { ["type"] = "text", ["text"] = commandOutput.ToJsonString() });
    }
    return result;
}
