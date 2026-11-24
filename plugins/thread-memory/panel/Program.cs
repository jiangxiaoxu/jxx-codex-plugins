using System.Buffers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using ThreadMemoryHook;

namespace ThreadMemoryPanel;

internal static class Program
{
    private const string ResourceUri = "ui://thread-memory/notes";
    private static readonly string Assets = Path.GetFullPath(Path.Combine(
        AppContext.BaseDirectory, "..", "skills", "thread-memory", "assets"));
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
    private static readonly JsonElement EmptyObject = JsonElement.Parse("{}"u8);
    private static readonly JsonObject ThreadId = new() { ["type"] = "string", ["format"] = "uuid" };

    private static readonly Tool[] Tools =
    [
        new("handoff_manager", "Thread Memory", "Browse current notes by main thread.", new(), []),
        new("handoff_list", "List main threads with notes",
            "List main threads with their own notes or saved subagent notes.", Paging(new()
            {
                ["selected_thread_id"] = ThreadId.DeepClone(),
                ["archive_status"] = new JsonObject
                {
                    ["type"] = "string", ["enum"] = new JsonArray("all", "active", "archived"), ["default"] = "all",
                },
                ["sort_by"] = new JsonObject
                {
                    ["type"] = "string", ["enum"] = new JsonArray("note_updated", "thread_updated"),
                    ["default"] = "note_updated",
                },
            }), []),
        new("handoff_children", "List subagent notes", "List spawned descendants with notes under a main thread.",
            Paging(new()
            {
                ["thread_id"] = ThreadId.DeepClone(),
                ["include_inherited"] = new JsonObject { ["type"] = "boolean", ["default"] = false },
            }), ["thread_id"]),
        new("handoff_read", "Read current thread note", "Read the thread's current saved note.",
            new() { ["thread_id"] = ThreadId.DeepClone(), ["from_fork"] = ThreadId.DeepClone() }, ["thread_id"]),
        new("handoff_cleanup", "Clean up deleted thread data",
            "Preview deleted local threads and remove their saved notes and indexes on confirmation.",
            new() { ["thread_ids"] = new JsonObject { ["type"] = "array", ["items"] = ThreadId } }, []),
    ];

    private static JsonObject Paging(JsonObject properties)
    {
        properties["query"] = new JsonObject { ["type"] = "string", ["maxLength"] = 256 };
        properties["limit"] = new JsonObject { ["type"] = "integer", ["minimum"] = 1, ["maximum"] = 100, ["default"] = 30 };
        properties["page"] = new JsonObject { ["type"] = "integer", ["minimum"] = 1, ["maximum"] = int.MaxValue, ["default"] = 1 };
        return properties;
    }

    public static int Main()
    {
        var home = Environment.GetEnvironmentVariable("CODEX_HOME");
        if (string.IsNullOrEmpty(home))
            home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");

        SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
        using var input = new BufferedStream(Console.OpenStandardInput());
        using var output = Console.OpenStandardOutput();
        var line = new ArrayBufferWriter<byte>();
        try
        {
            int value;
            do
            {
                value = input.ReadByte();
                if (value is -1 or '\n')
                {
                    if ((value == '\n' || line.WrittenCount != 0) && Respond(home, line.WrittenMemory) is { } reply)
                    {
                        using var writer = new Utf8JsonWriter(output);
                        reply.WriteTo(writer);
                        writer.Flush();
                        output.WriteByte((byte)'\n');
                        output.Flush();
                    }
                    line.Clear();
                }
                else
                {
                    line.GetSpan(1)[0] = (byte)value;
                    line.Advance(1);
                }
            } while (value != -1);
            return 0;
        }
        catch (IOException)
        {
            return 1;
        }
    }

    private static JsonObject? Respond(string home, ReadOnlyMemory<byte> raw)
    {
        var reply = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = null };
        JsonDocument document;
        try
        {
            if (raw.Span.StartsWith(Encoding.UTF8.Preamble))
                raw = raw[Encoding.UTF8.Preamble.Length..];
            Utf8.GetCharCount(raw.Span);
            document = JsonDocument.Parse(raw, new JsonDocumentOptions { MaxDepth = 1000 });
        }
        catch (Exception error) when (error is JsonException or DecoderFallbackException)
        {
            return RpcError(reply, -32700, "Parse error.");
        }

        using (document)
        {
            var request = document.RootElement;
            try
            {
                if (request.ValueKind != JsonValueKind.Object || String(request, "jsonrpc") != "2.0" ||
                    String(request, "method") is not { } method)
                    return RpcError(reply, -32600, "Invalid request.");
                if (!request.TryGetProperty("id", out var id))
                    return null;
                if (id.ValueKind is not (JsonValueKind.String or JsonValueKind.Number or JsonValueKind.Null))
                    return RpcError(reply, -32600, "Invalid request.");
                if (id.ValueKind != JsonValueKind.Null)
                    reply["id"] = id.ValueKind == JsonValueKind.String ? JsonValue.Create(id.GetString()) :
                        JsonNode.Parse(id.GetRawText());
                var args = request.TryGetProperty("params", out var supplied) ? supplied : EmptyObject;
                if (args.ValueKind != JsonValueKind.Object)
                    return RpcError(reply, -32602, "Expected a parameter object.");

                var result = method switch
                {
                    "initialize" => Initialize(args),
                    "ping" => new JsonObject(),
                    "tools/list" => new JsonObject { ["tools"] = ToolDescriptors() },
                    "tools/call" => CallTool(home, args),
                    "resources/list" => new JsonObject { ["resources"] = new JsonArray(Resource()) },
                    "resources/templates/list" => new JsonObject { ["resourceTemplates"] = new JsonArray() },
                    "resources/read" => ReadResource(args),
                    _ => null,
                };
                if (result is null)
                    return RpcError(reply, -32601, "Method not found.");
                reply["result"] = result;
                return reply;
            }
            catch (InvalidOperationException)
            {
                return RpcError(reply, -32602, "Invalid parameter text.");
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
            {
                return RpcError(reply, -32603, "The panel resource could not be read.");
            }
            catch (ArgumentException error)
            {
                return RpcError(reply, -32602, error.Message);
            }
        }
    }

    private static JsonObject RpcError(JsonObject reply, int code, string message)
    {
        reply["error"] = new JsonObject { ["code"] = code, ["message"] = MediaText.OmitDataUrls(message) };
        return reply;
    }

    private static JsonObject Initialize(JsonElement args)
    {
        var version = String(args, "protocolVersion");
        return new JsonObject
        {
            ["protocolVersion"] = version is "2024-11-05" or "2025-03-26" or "2025-06-18" or "2025-11-25" or "2026-07-28"
                ? version : "2025-11-25",
            ["capabilities"] = new JsonObject { ["tools"] = new JsonObject(), ["resources"] = new JsonObject() },
            ["serverInfo"] = new JsonObject { ["name"] = "thread-memory", ["version"] = "1" },
        };
    }

    private static JsonObject Resource() => new()
    {
        ["uri"] = ResourceUri,
        ["name"] = "Thread Memory",
        ["mimeType"] = "text/html;profile=mcp-app",
        ["_meta"] = new JsonObject
        {
            ["ui"] = new JsonObject { ["permissions"] = new JsonObject { ["clipboardWrite"] = new JsonObject() } },
        },
    };

    private static JsonObject ReadResource(JsonElement args)
    {
        if (String(args, "uri") != ResourceUri)
            throw new ArgumentException("Unknown UI resource.");
        var resource = Resource();
        resource["text"] = File.ReadAllText(Path.Combine(Assets, "handoffs.html"), Utf8);
        return new JsonObject { ["contents"] = new JsonArray(resource) };
    }

    private static JsonArray ToolDescriptors()
    {
        var descriptors = new JsonArray();
        foreach (var tool in Tools)
        {
            var ui = new JsonObject { ["visibility"] = new JsonArray("app") };
            var meta = new JsonObject { ["ui"] = ui };
            var destructive = tool.Name == "handoff_cleanup";
            var descriptor = new JsonObject
            {
                ["name"] = tool.Name,
                ["title"] = tool.Title,
                ["description"] = tool.Description,
                ["inputSchema"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = tool.Properties.DeepClone(),
                    ["required"] = new JsonArray(tool.Required.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()),
                    ["additionalProperties"] = false,
                },
                ["annotations"] = new JsonObject
                {
                    ["readOnlyHint"] = !destructive, ["destructiveHint"] = destructive,
                    ["idempotentHint"] = destructive, ["openWorldHint"] = false,
                },
                ["_meta"] = meta,
            };
            if (tool.Name == "handoff_manager")
            {
                ui["resourceUri"] = ResourceUri;
                meta["openai/ui"] = new JsonObject
                {
                    ["entrypoints"] = new JsonArray(new JsonObject { ["type"] = "global" }),
                };
                try
                {
                    var icon = File.ReadAllBytes(Path.Combine(Assets, "thread-memory-entrypoint.png"));
                    descriptor["icons"] = new JsonArray(new JsonObject
                    {
                        ["src"] = $"data:image/png;base64,{Convert.ToBase64String(icon)}",
                        ["mimeType"] = "image/png",
                        ["sizes"] = new JsonArray("64x64"),
                    });
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    // Codex can still open the app with its fallback icon.
                }
            }
            descriptors.Add((JsonNode)descriptor);
        }
        return descriptors;
    }

    private static JsonObject CallTool(string home, JsonElement request)
    {
        var name = String(request, "name");
        var tool = Array.Find(Tools, item => item.Name == name);
        if (tool is null)
            return ToolError("Unknown handoff tool.");
        var args = request.TryGetProperty("arguments", out var supplied) ? supplied : EmptyObject;
        if (args.ValueKind != JsonValueKind.Object ||
            args.EnumerateObject().Any(property => !tool.Properties.ContainsKey(property.Name)) ||
            tool.Required.Any(required => !args.TryGetProperty(required, out _)))
            return ToolError("Invalid handoff tool arguments.");

        try
        {
            var result = name switch
            {
                "handoff_list" => PanelThreads.List(home, args),
                "handoff_children" => PanelThreads.ListChildren(home, args),
                "handoff_read" => PanelThreads.Read(home, args),
                "handoff_cleanup" => PanelCleanup.Run(home, args),
                _ => new JsonObject(),
            };
            return new JsonObject { ["content"] = new JsonArray(), ["structuredContent"] = result };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SqliteException or JsonException
                                      or DecoderFallbackException)
        {
            return ToolError("The local thread data could not be read or updated.");
        }
        catch (Exception error) when (error is ArgumentException or InvalidDataException)
        {
            return ToolError(error.Message);
        }
    }

    private static JsonObject ToolError(string message) => new()
    {
        ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = MediaText.OmitDataUrls(message) }),
        ["isError"] = true,
    };

    private static string? String(JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;

    private sealed record Tool(string Name, string Title, string Description, JsonObject Properties, string[] Required);
}
