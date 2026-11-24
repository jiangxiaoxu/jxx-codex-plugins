#:property PublishAot=false

using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using ZstdSharp;

if (args.Length > 2)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-panel.cs -- [panel.exe] [cli.exe]");
    return 2;
}

string plugin = PluginDirectory();
string panel = Path.GetFullPath(args.Length > 0 ? args[0] : Path.Combine(plugin, "bin", "Thread-Memory-Panel.exe"));
string cli = Path.GetFullPath(args.Length > 1 ? args[1] : Path.Combine(plugin, "bin", "Thread-Memory.exe"));
using var temporary = new TemporaryDirectory();
try
{
    SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_winsqlite3());
    await VerifyPanel(Path.Combine(temporary.Path, "listing"), panel, cli, plugin);
    await VerifyCleanup(Path.Combine(temporary.Path, "cleanup"), panel, cli);
    Console.WriteLine("Thread Memory MCP panel checks passed.");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

static string PluginDirectory([CallerFilePath] string path = "") =>
    Path.GetDirectoryName(Path.GetDirectoryName(path))!;

static async Task VerifyPanel(string home, string panel, string cli, string plugin)
{
    Directory.CreateDirectory(home);
    await using var mcp = new McpClient(panel, home);
    var initialize = await mcp.Request("initialize", new { protocolVersion = "2025-11-25" });
    Check(initialize.GetProperty("protocolVersion").GetString() == "2025-11-25"
        && initialize.GetProperty("capabilities").TryGetProperty("tools", out _)
        && initialize.GetProperty("capabilities").TryGetProperty("resources", out _), "MCP initialization returned invalid capabilities.");
    await mcp.Notify("notifications/initialized");

    var tools = (await mcp.Request("tools/list")).GetProperty("tools").EnumerateArray().ToArray();
    string[] expected = ["handoff_cleanup", "handoff_list", "handoff_manager", "handoff_read"];
    Check(tools.Select(tool => tool.GetProperty("name").GetString()).Order().SequenceEqual(expected),
        "The panel advertises unexpected tools.");
    foreach (var tool in tools)
        Check(tool.GetProperty("_meta").GetProperty("ui").GetProperty("visibility").EnumerateArray()
            .Select(value => value.GetString()).SequenceEqual(["app"]), "Panel tools must be app-only.");

    const string uri = "ui://thread-memory/notes";
    var entrypoint = tools.Single(tool => tool.GetProperty("name").GetString() == "handoff_manager");
    var metadata = entrypoint.GetProperty("_meta");
    Check(metadata.GetProperty("ui").GetProperty("resourceUri").GetString() == uri
        && metadata.GetProperty("openai/ui").GetProperty("entrypoints")[0].GetProperty("type").GetString() == "global",
        "The panel does not advertise a global sidebar entrypoint.");
    var icon = entrypoint.GetProperty("icons")[0];
    const string dataPrefix = "data:image/png;base64,";
    string iconSource = icon.GetProperty("src").GetString()!;
    Check(iconSource.StartsWith(dataPrefix, StringComparison.Ordinal) && icon.GetProperty("mimeType").GetString() == "image/png"
        && Convert.FromBase64String(iconSource[dataPrefix.Length..]).SequenceEqual(File.ReadAllBytes(Path.Combine(
            plugin, "skills", "thread-memory", "assets", "thread-memory-entrypoint.png"))), "The sidebar icon has incorrect bytes or MIME type.");

    var resource = (await mcp.Request("resources/read", new { uri })).GetProperty("contents")[0];
    Check(resource.GetProperty("mimeType").GetString() == "text/html;profile=mcp-app"
        && resource.GetProperty("text").GetString() == File.ReadAllText(Path.Combine(plugin, "skills", "thread-memory", "assets", "handoffs.html")),
        "The MCP resource did not return the packaged panel HTML.");
    await mcp.Tool("handoff_manager");

    string active = NewId(), archived = NewId(), fallback = NewId(), spawned = NewId();
    string database = CreateThreadIndex(home);
    AddThread(database, active, "Needle 活跃", "Résumé from Codex", archived: false, updatedMs: 1_799_020_800_123);
    AddThread(database, archived, "Needle archived", "Preview data:image/png;base64,cGFuZWwtcHJldmlldy1zZWNyZXQ= ended",
        archived: true, updatedMs: 1_767_225_600_000);
    AddThread(database, spawned, "Needle child", null, archived: false, updatedMs: 1_799_020_800_124);
    Execute(database, "INSERT INTO thread_spawn_edges VALUES ($parent, $child, 'closed')", ("$parent", active), ("$child", spawned));

    string fallbackPath = WriteRollout(home, fallback, archived: true);
    await SaveNote(cli, home, fallback, "Archived note without an index row");
    using (var compressor = new Compressor())
        File.WriteAllBytes(fallbackPath + ".zst", compressor.Wrap(File.ReadAllBytes(fallbackPath)).ToArray());
    File.Delete(fallbackPath);
    WriteRollout(home, active);
    const string summary = "Goal\n保留笔记 🎯\nNext";
    var activeWrite = await SaveNote(cli, home, active, summary);
    WriteRollout(home, archived, archived: true);
    await SaveNote(cli, home, archived, "Archived note");
    WriteRollout(home, spawned);
    await SaveNote(cli, home, spawned, "Excluded from the main-thread directory");

    var first = await mcp.Tool("handoff_list", new { limit = 2 });
    Check(first.GetProperty("total").GetInt32() == 3 && ThreadIds(first).SequenceEqual([archived, active]),
        "The directory must filter auxiliary threads before sorting and paging.");
    string cursor = first.GetProperty("next_cursor").GetString()!;
    var last = await mcp.Tool("handoff_list", new { limit = 2, cursor });
    Check(ThreadIds(last).SequenceEqual([fallback]) && last.GetProperty("next_cursor").ValueKind == JsonValueKind.Null
        && last.GetProperty("items")[0].GetProperty("archived").GetBoolean(),
        "The final page must include the archived main thread verified by its compressed rollout header.");

    var byThread = await mcp.Tool("handoff_list", new { query = "  NEEDLE  ", sort_by = "thread_updated" });
    var firstItem = byThread.GetProperty("items")[0];
    Check(ThreadIds(byThread).SequenceEqual([active, archived])
        && firstItem.GetProperty("title").GetString() == "Needle 活跃"
        && firstItem.GetProperty("preview").GetString() == "Résumé from Codex"
        && firstItem.GetProperty("thread_updated_at").GetString() == "2027-01-04T00:00:00.123Z",
        "The panel must search titles and order matches by Codex activity when requested.");
    Check(byThread.GetProperty("items")[1].GetProperty("preview").GetString() == "Preview [data URL omitted] ended"
        && !byThread.GetProperty("items").EnumerateArray().Any(item => item.TryGetProperty("summary", out _)),
        "The directory must omit Base64 previews and saved note bodies.");
    var archivedOnly = await mcp.Tool("handoff_list", new { query = "Needle", archive_status = "archived" });
    var activeOnly = await mcp.Tool("handoff_list", new { archive_status = "active" });
    Check(ThreadIds(archivedOnly).SequenceEqual([archived]) && ThreadIds(activeOnly).SequenceEqual([active]),
        "The panel did not apply the archive filter before counting and paging.");

    var read = await mcp.Tool("handoff_read", new { thread_id = active });
    Check(read.GetProperty("thread_id").GetString() == active && read.GetProperty("summary").GetString() == summary
        && read.GetProperty("updated_at").GetString() == activeWrite.GetProperty("updated_at").GetString(),
        "The panel did not read the current CLI note and timestamp verbatim.");
    await mcp.Finish();
}

static async Task VerifyCleanup(string home, string panel, string cli)
{
    Directory.CreateDirectory(home);
    await using var mcp = new McpClient(panel, home);
    string parent = NewId(), fork = NewId(), deletedChild = NewId(), archived = NewId(), restored = NewId(), searchOnly = NewId();
    string parentPath = WriteRollout(home, parent);
    string deletedChildPath = WriteRollout(home, deletedChild, source: new { subagent = new { thread_spawn = new { parent_thread_id = parent } } });
    string restoredPath = WriteRollout(home, restored);
    string archivePath = WriteRollout(home, archived, archived: true);
    string indexedPath = WriteRollout(home, searchOnly, withMessage: true);
    const string snapshot = "Save this version for the archived fork";
    var snapshotWrite = await SaveNote(cli, home, parent, snapshot);
    string forkPath = WriteRollout(home, fork, archived: true, forkedFrom: parent,
        timestamp: snapshotWrite.GetProperty("updated_at").GetString()!);
    await SaveNote(cli, home, parent, "Parent note updated after the fork");
    await SaveNote(cli, home, deletedChild, "Deleted subagent's note");
    await SaveNote(cli, home, restored, "Restored after preview");
    await SaveNote(cli, home, archived, "Keep archived notes");
    var indexed = await RunCli(cli, home, null, null,
        "search", "Cache this message", "--rollout", indexedPath, "--since", "2026-01-01T00:00:00Z");
    Check(indexed.GetProperty("items").GetArrayLength() == 1, "Could not build the rollout index fixture.");
    foreach (string path in new[] { parentPath, deletedChildPath, restoredPath, indexedPath })
        File.Delete(path);

    string[] confirmed = [parent, deletedChild, restored, archived, searchOnly];
    var unavailable = await mcp.Tool("handoff_cleanup", new { thread_ids = confirmed });
    Check(unavailable.GetProperty("status").GetString() == "unavailable" && unavailable.GetProperty("thread_ids").GetArrayLength() == 0,
        "Cleanup must require a readable Codex index before deleting notes.");
    string database = CreateThreadIndex(home, backfill: "running");
    unavailable = await mcp.Tool("handoff_cleanup", new { thread_ids = confirmed });
    Check(unavailable.GetProperty("status").GetString() == "unavailable",
        "Cleanup must wait for the local Codex index backfill.");
    Execute(database, "UPDATE backfill_state SET status = 'complete' WHERE id = 1");

    Execute(database, "INSERT INTO thread_spawn_edges VALUES ($parent, $child, 'closed')", ("$parent", parent), ("$child", deletedChild));
    var protectedTree = await mcp.Tool("handoff_cleanup");
    Check(CleanupIds(protectedTree).Order().SequenceEqual(new[] { restored, searchOnly }.Order()),
        "A surviving spawn edge must protect both ends during cleanup preview.");
    Execute(database, "DELETE FROM thread_spawn_edges");
    var preview = await mcp.Tool("handoff_cleanup");
    Check(CleanupIds(preview).Order().SequenceEqual(new[] { parent, deletedChild, restored, searchOnly }.Order()),
        "Cleanup preview missed deleted thread state or selected an archived thread.");
    var before = await mcp.Tool("handoff_read", new { thread_id = fork });
    Check(before.GetProperty("summary").ValueKind == JsonValueKind.Null, "Cleanup preview must not initialize the surviving fork.");

    WriteRollout(home, restored, archived: true);
    var result = await mcp.Tool("handoff_cleanup", new { thread_ids = confirmed });
    Check(CleanupIds(result).Order().SequenceEqual(new[] { parent, deletedChild, searchOnly }.Order())
        && result.GetProperty("deleted").GetInt32() >= 3, "Cleanup must revalidate and delete only vanished thread state.");
    Check(File.Exists(archivePath) && File.Exists(forkPath), "Cleanup must not remove Codex rollout files.");
    foreach (string id in new[] { parent, deletedChild })
    {
        var note = await mcp.Tool("handoff_read", new { thread_id = id });
        Check(note.GetProperty("summary").ValueKind == JsonValueKind.Null, "Cleanup did not remove a deleted thread note.");
    }
    var forkNote = await mcp.Tool("handoff_read", new { thread_id = fork });
    Check(forkNote.GetProperty("summary").GetString() == snapshot
        && forkNote.GetProperty("updated_at").GetString() == snapshotWrite.GetProperty("updated_at").GetString(),
        "Cleanup must copy a surviving fork's note as of fork time before deleting the parent.");
    foreach (string id in new[] { archived, restored })
    {
        var note = await mcp.Tool("handoff_read", new { thread_id = id });
        Check(note.GetProperty("summary").ValueKind == JsonValueKind.String, "Cleanup removed a surviving archived thread note.");
    }
    Check(!CleanupIds(await mcp.Tool("handoff_cleanup")).Any(), "Cleanup left deleted rollout search entries behind.");

    string attachedSource = NewId();
    string attachedSourcePath = WriteRollout(home, attachedSource, withMessage: true);
    await RunCli(cli, home, null, null,
        "search", "Cache this message", "--rollout", attachedSourcePath, "--since", "2026-01-01T00:00:00Z");
    File.Delete(attachedSourcePath);
    WriteRollout(home, NewId(), archived: true, forkedFrom: attachedSource, attached: true);
    string unresolvedSource = NewId();
    string unresolvedPath = WriteRollout(home, unresolvedSource);
    await SaveNote(cli, home, unresolvedSource, "Cannot safely delete an unresolved source");
    File.Delete(unresolvedPath);
    string damaged = WriteRollout(home, NewId(), archived: true, forkedFrom: unresolvedSource);
    File.WriteAllText(damaged, "incomplete header");
    var kept = await mcp.Tool("handoff_cleanup", new { thread_ids = new[] { attachedSource, unresolvedSource } });
    Check(!CleanupIds(kept).Any() && kept.GetProperty("deleted").GetInt32() == 0
        && kept.GetProperty("kept_thread_ids").EnumerateArray().Select(value => value.GetString()).Order()
            .SequenceEqual(new[] { attachedSource, unresolvedSource }.Order()),
        "A surviving attachment or unreadable fork relation must protect its source data.");
    await mcp.Finish();
}

static string NewId() => Guid.NewGuid().ToString("D");

static string WriteRollout(string home, string id, bool archived = false, string? forkedFrom = null,
    string timestamp = "2026-01-01T00:00:00Z", object? source = null, bool withMessage = false, bool attached = false)
{
    string directory = Path.Combine(home, archived ? "archived_sessions" : "sessions");
    Directory.CreateDirectory(directory);
    string path = Path.Combine(directory, $"rollout-2026-01-01T00-00-00-{id}.jsonl");
    Dictionary<string, object> payload = new() { ["id"] = id, ["timestamp"] = timestamp, ["source"] = source ?? "vscode" };
    if (forkedFrom is not null)
        payload["forked_from_id"] = forkedFrom;
    if (attached)
        payload["attached_thread"] = true;
    File.WriteAllText(path, JsonSerializer.Serialize(new { type = "session_meta", timestamp, payload }) + "\n");
    if (withMessage)
        File.AppendAllText(path, """
            {"type":"response_item","timestamp":"2026-01-01T12:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Cache this message"}]}}
            """ + "\n");
    return path;
}

static string CreateThreadIndex(string home, string backfill = "complete")
{
    string database = Path.Combine(home, "state_5.sqlite");
    Execute(database, """
        CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, title TEXT, preview TEXT,
            first_user_message TEXT, source TEXT NOT NULL DEFAULT 'vscode', thread_source TEXT,
            archived INTEGER NOT NULL DEFAULT 0, attached_thread_parent_id TEXT, updated_at_ms INTEGER);
        CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT);
        INSERT INTO backfill_state VALUES (1, $backfill);
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT NOT NULL);
        """, ("$backfill", backfill));
    return database;
}

static void AddThread(string database, string id, string title, string? preview, bool archived, long updatedMs) =>
    Execute(database, "INSERT INTO threads (id, title, preview, archived, updated_at_ms) VALUES ($id, $title, $preview, $archived, $updated)",
        ("$id", id), ("$title", title), ("$preview", preview), ("$archived", archived), ("$updated", updatedMs));

static void Execute(string database, string sql, params (string Name, object? Value)[] inputs)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = database, Pooling = false }.ToString());
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = sql;
    foreach (var input in inputs)
        command.Parameters.AddWithValue(input.Name, input.Value ?? DBNull.Value);
    command.ExecuteNonQuery();
}

static IEnumerable<string?> ThreadIds(JsonElement page) =>
    page.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("thread_id").GetString());

static IEnumerable<string?> CleanupIds(JsonElement result)
{
    Check(result.GetProperty("status").GetString() == "ok", $"Cleanup failed: {result}");
    return result.GetProperty("thread_ids").EnumerateArray().Select(item => item.GetString());
}

static async Task<JsonElement> SaveNote(string cli, string home, string id, string note)
{
    var result = await RunCli(cli, home, id, note, "memory", "write");
    Check(result.GetProperty("saved").GetBoolean(), "Could not save the note fixture.");
    return result;
}

static async Task<JsonElement> RunCli(string cli, string home, string? id, string? input, params string[] arguments)
{
    using var process = ChildProcess.Start(cli, home, arguments, id);
    process.StandardInput.Write(input);
    process.StandardInput.Close();
    var output = process.StandardOutput.ReadToEndAsync();
    var error = process.StandardError.ReadToEndAsync();
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    try
    {
        await process.WaitForExitAsync(timeout.Token);
    }
    finally
    {
        if (!process.HasExited)
            process.Kill(entireProcessTree: true);
    }
    Check(process.ExitCode == 0 && (await error).Length == 0, $"CLI fixture command failed: {await error}");
    return JsonSerializer.Deserialize<JsonElement>(await output);
}

static void Check(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

sealed class TemporaryDirectory : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("thread-memory-panel-").FullName;

    public void Dispose() => Directory.Delete(Path, recursive: true);
}

static class ChildProcess
{
    public static Process Start(string executable, string home, string[] arguments, string? thread = null)
    {
        var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
        ProcessStartInfo info = new(executable)
        {
            CreateNoWindow = true, UseShellExecute = false,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardInputEncoding = utf8, StandardOutputEncoding = utf8, StandardErrorEncoding = utf8,
        };
        foreach (string argument in arguments)
            info.ArgumentList.Add(argument);
        info.Environment["CODEX_HOME"] = home;
        info.Environment["CODEX_SQLITE_HOME"] = home;
        info.Environment.Remove("CODEX_THREAD_ID");
        if (thread is not null)
            info.Environment["CODEX_THREAD_ID"] = thread;
        return Process.Start(info) ?? throw new InvalidOperationException($"Could not start {executable}.");
    }
}

sealed class McpClient : IAsyncDisposable
{
    private readonly Process process;
    private readonly Task<string> errors;
    private readonly CancellationTokenSource timeout = new(TimeSpan.FromSeconds(30));
    private int next;

    public McpClient(string panel, string home)
    {
        process = ChildProcess.Start(panel, home, []);
        errors = process.StandardError.ReadToEndAsync();
    }

    public async Task Notify(string method)
    {
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { jsonrpc = "2.0", method }).AsMemory(), timeout.Token);
        await process.StandardInput.FlushAsync(timeout.Token);
    }

    public async Task<JsonElement> Request(string method, object? parameters = null)
    {
        int id = ++next;
        var request = new { jsonrpc = "2.0", id, method, @params = parameters ?? new object() };
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request).AsMemory(), timeout.Token);
        await process.StandardInput.FlushAsync(timeout.Token);
        string line = await process.StandardOutput.ReadLineAsync(timeout.Token)
            ?? throw new InvalidOperationException($"The MCP process exited without responding to {method}: {await errors}");
        var response = JsonSerializer.Deserialize<JsonElement>(line);
        if (!response.TryGetProperty("id", out var responseId) || responseId.GetInt32() != id
            || !response.TryGetProperty("result", out var result))
            throw new InvalidOperationException($"Unexpected MCP response to {method}: {line}");
        return result;
    }

    public async Task<JsonElement> Tool(string name, object? arguments = null)
    {
        var result = await Request("tools/call", new { name, arguments = arguments ?? new object() });
        return result.TryGetProperty("structuredContent", out var value)
            ? value : throw new InvalidOperationException($"MCP tool {name} failed: {result}");
    }

    public async Task Finish()
    {
        process.StandardInput.Close();
        await process.WaitForExitAsync(timeout.Token);
        if (process.ExitCode != 0 || (await errors).Length != 0)
            throw new InvalidOperationException($"MCP process did not exit cleanly: {await errors}");
    }

    public async ValueTask DisposeAsync()
    {
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }
        process.Dispose();
        timeout.Dispose();
    }
}
