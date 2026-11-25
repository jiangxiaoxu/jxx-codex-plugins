#:property PublishAot=false

using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
    await VerifySelectionAndIndexAvailability(Path.Combine(temporary.Path, "selection"), panel, cli);
    await VerifyChildDirectory(Path.Combine(temporary.Path, "children"), panel, cli);
    await VerifyForkDirectory(Path.Combine(temporary.Path, "fork-children"), panel, cli);
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
    string[] expected = ["handoff_children", "handoff_cleanup", "handoff_list", "handoff_manager", "handoff_read"];
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
    string? resourceHtml = resource.GetProperty("text").GetString();
    using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(
        Path.GetDirectoryName(panel)!, "..", ".codex-plugin", "plugin.json")));
    string? version = manifest.RootElement.GetProperty("version").GetString();
    string versionBadge = $" <span id=\"plugin-version\" class=\"meta\">v{WebUtility.HtmlEncode(version)}</span>";
    string template = File.ReadAllText(Path.Combine(plugin, "skills", "thread-memory", "assets", "handoffs.html"));
    Check(resource.GetProperty("mimeType").GetString() == "text/html;profile=mcp-app"
        && resourceHtml?.Contains($"<h1>Thread Memory{versionBadge}</h1>", StringComparison.Ordinal) == true
        && resourceHtml == template.Replace("<!-- plugin-version -->", versionBadge, StringComparison.Ordinal),
        "The MCP resource did not return the packaged panel HTML with the manifest version in the heading.");
    await mcp.Tool("handoff_manager");

    string active = NewId(), archived = NewId(), fallback = NewId(), spawned = NewId();
    string database = CreateThreadIndex(home);
    AddThread(database, active, "Needle 活跃", "Résumé from Codex", archived: false, updatedMs: 1_799_020_800_123);
    AddThread(database, archived, "Needle archived", "Preview data:image/png;base64,cGFuZWwtcHJldmlldy1zZWNyZXQ= ended",
        archived: true, updatedMs: 1_767_225_600_000);
    AddThread(database, spawned, "Needle child", null, archived: false, updatedMs: 1_799_020_800_124);
    Execute(database, "INSERT INTO thread_spawn_edges VALUES ($parent, $child, 'closed')", ("$parent", active), ("$child", spawned));
    var missingStore = await mcp.Tool("handoff_list", new { selected_thread_id = active });
    var missingChildStore = await mcp.Tool("handoff_children", new { thread_id = active });
    var unreadableNote = await mcp.Tool("handoff_read", new { thread_id = spawned });
    Check(!missingStore.GetProperty("note_store_available").GetBoolean()
        && !missingChildStore.GetProperty("note_store_available").GetBoolean()
        && missingStore.GetProperty("selected_available").ValueKind == JsonValueKind.Null
        && unreadableNote.GetProperty("note_available").ValueKind == JsonValueKind.Null,
        "The missing note store cannot confirm that a selection, directory row, or note was removed.");

    string fallbackPath = WriteRollout(home, fallback, archived: true);
    await SaveNote(cli, home, fallback, "Archived note without an index row");
    using (var compressor = new Compressor())
        File.WriteAllBytes(fallbackPath + ".zst", compressor.Wrap(File.ReadAllBytes(fallbackPath)).ToArray());
    File.Delete(fallbackPath);
    WriteRollout(home, active);
    string summary = """
        # Goal 🎯
        ## Current progress

        > 保留笔记

        - Checklist
          1. [x] Render note
          2. [ ] Read note

        Use `look <up>`.

        ```text
        <raw>
        ```

        <script>alert(1)</script>

        [Local file](E:/Project/note.md)
        <https://example.invalid/autolink>
        ![Remote image](https://example.invalid/tracker.png)
        """.ReplaceLineEndings("\n");
    await SaveNote(cli, home, active, summary);
    string activeUpdatedAt = NoteUpdatedAt(home, active);
    WriteRollout(home, spawned);
    await SaveNote(cli, home, spawned, "Shown under its main thread");
    WriteRollout(home, archived, archived: true);
    await SaveNote(cli, home, archived, "Archived note");

    var first = await mcp.Tool("handoff_list", new { limit = 2 });
    Check(first.GetProperty("total").GetInt32() == 3 && first.GetProperty("total_pages").GetInt32() == 2
        && first.GetProperty("page").GetInt32() == 1 && ThreadIds(first).SequenceEqual([archived, active]),
        "The directory must filter auxiliary threads before sorting and paging.");
    var last = await mcp.Tool("handoff_list", new { limit = 2, page = 2 });
    Check(ThreadIds(last).SequenceEqual([fallback]) && last.GetProperty("page").GetInt32() == 2
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
    var activeOnly = await mcp.Tool("handoff_list", new { archive_status = "active", limit = 2, page = int.MaxValue });
    Check(ThreadIds(archivedOnly).SequenceEqual([archived]) && ThreadIds(activeOnly).SequenceEqual([active])
        && activeOnly.GetProperty("page").GetInt32() == 1 && activeOnly.GetProperty("total_pages").GetInt32() == 1,
        "The panel did not apply the archive filter before counting and paging.");
    var empty = await mcp.Tool("handoff_list", new { query = "No matching thread", limit = 2, page = 2 });
    Check(!ThreadIds(empty).Any() && empty.GetProperty("total").GetInt32() == 0
        && empty.GetProperty("page").GetInt32() == 1 && empty.GetProperty("total_pages").GetInt32() == 1,
        "An empty directory must return page one.");

    await SaveNote(cli, home, fallback, "Recently updated archived note");
    var refreshed = await mcp.Tool("handoff_list", new { limit = 2, page = 2 });
    Check(ThreadIds(refreshed).SequenceEqual([active]) && refreshed.GetProperty("page").GetInt32() == 2,
        "Refreshing the same page number must use the current note order.");

    var read = await mcp.Tool("handoff_read", new { thread_id = active });
    Check(read.GetProperty("thread_id").GetString() == active && read.GetProperty("summary").GetString() == summary
        && read.GetProperty("updated_at").GetString() == activeUpdatedAt,
        "The panel did not read the current CLI note and timestamp verbatim.");
    Check(read.TryGetProperty("summary_html", out var rendered) && rendered.ValueKind == JsonValueKind.String,
        "The note reader did not return rendered Markdown.");
    string html = rendered.GetString()!;
    Check(Regex.IsMatch(html, @"<h3>Goal .*?</h3>") && html.Contains("<h4>Current progress</h4>", StringComparison.Ordinal)
        && Regex.IsMatch(html, @"(?s)<blockquote>\s*<p>保留笔记</p>\s*</blockquote>")
        && Regex.IsMatch(html, @"(?s)<ul\b[^>]*>\s*<li\b[^>]*>Checklist\s*<ol\b[^>]*>.*?Render note.*?Read note.*?</ol>\s*</li>\s*</ul>"),
        "The note should have reader-level headings, a quote, and a genuinely nested ordered list.");
    var boxes = Regex.Matches(html, @"<input\b[^>]*>");
    Check(boxes.Count == 2 && boxes.All(box => box.Value.Contains("type=\"checkbox\"", StringComparison.Ordinal)
            && Regex.IsMatch(box.Value, @"\sdisabled[\s=/>]"))
        && Regex.IsMatch(boxes[0].Value, @"\schecked[\s=/>]") && !Regex.IsMatch(boxes[1].Value, @"\schecked[\s=/>]"),
        "The task list must retain both saved checkbox states and disable both controls.");
    Check(html.Contains("<code>look &lt;up&gt;</code>", StringComparison.Ordinal)
        && Regex.IsMatch(html, @"<pre><code[^>]*>&lt;raw&gt;\r?\n</code></pre>"),
        "Inline and fenced code must keep literal angle brackets.");
    Check(!Regex.IsMatch(html, @"<(?:a|img|script)\b", RegexOptions.IgnoreCase)
        && html.Contains("&lt;script&gt;alert(1)&lt;/script&gt;", StringComparison.Ordinal)
        && html.Contains("Local file", StringComparison.Ordinal)
        && html.Contains("E:/Project/note.md", StringComparison.Ordinal)
        && html.Contains("https://example.invalid/autolink", StringComparison.Ordinal)
        && html.Contains("Remote image", StringComparison.Ordinal),
        "Markdown links, images, and inline HTML must remain inert in the panel.");

    string deeplyNested = string.Concat(Enumerable.Repeat("> ", 150)) + "<script>alert(1)</script>";
    await SaveNote(cli, home, active, deeplyNested);
    var fallbackRead = await mcp.Tool("handoff_read", new { thread_id = active });
    string? fallbackHtml = fallbackRead.GetProperty("summary_html").GetString();
    Check(fallbackRead.GetProperty("summary").GetString() == deeplyNested
        && fallbackHtml is not null
        && Regex.Match(fallbackHtml, @"\A<pre>([^<]+)</pre>\s*\z") is { Success: true } plainText
        && WebUtility.HtmlDecode(plainText.Groups[1].Value) == deeplyNested,
        "A note that exceeds the Markdown nesting limit must remain readable as escaped plain text.");
    await mcp.Finish();
}

static async Task VerifySelectionAndIndexAvailability(string home, string panel, string cli)
{
    Directory.CreateDirectory(home);
    string selected = NewId(), keeper = NewId();
    string database = CreateThreadIndex(home);
    AddThread(database, selected, "Selected thread", null, archived: false, updatedMs: 2);
    AddThread(database, keeper, "Keep in directory", null, archived: false, updatedMs: 1);
    WriteRollout(home, selected);
    WriteRollout(home, keeper);
    await SaveNote(cli, home, selected, "Selected note");
    await SaveNote(cli, home, keeper, "Visible note");
    await using var mcp = new McpClient(panel, home);

    var before = await mcp.Tool("handoff_list", new { selected_thread_id = selected, sort_by = "thread_updated", limit = 1 });
    Check(ThreadIds(before).SequenceEqual([selected]) && !before.GetProperty("selected_archived").GetBoolean()
        && before.GetProperty("selected_available").GetBoolean()
        && before.GetProperty("spawn_index_available").GetBoolean()
        && before.GetProperty("items")[0].GetProperty("child_note_count").GetInt32() == 0,
        "A verified selection must show its current archive status and a confirmed empty spawn count.");
    var empty = await mcp.Tool("handoff_children", new { thread_id = selected });
    Check(empty.GetProperty("spawn_index_available").GetBoolean() && empty.GetProperty("note_store_available").GetBoolean()
        && empty.GetProperty("total").GetInt32() == 0,
        "A usable empty spawn index must report a verified empty child directory.");
    Execute(database, "UPDATE backfill_state SET status = 'running' WHERE id = 1");
    var backfilling = await mcp.Tool("handoff_children", new { thread_id = selected });
    Check(!backfilling.GetProperty("spawn_index_available").GetBoolean(),
        "The child directory cannot classify a partially populated index as empty.");
    Execute(database, "UPDATE backfill_state SET status = 'complete' WHERE id = 1");
    var recovered = await mcp.Tool("handoff_children", new { thread_id = selected });
    Check(recovered.GetProperty("spawn_index_available").GetBoolean(),
        "The child directory must recover as soon as the index is complete.");

    Execute(database, "UPDATE threads SET archived = 1 WHERE id = $id", ("$id", selected));
    var refreshed = await mcp.Tool("handoff_list", new
    {
        selected_thread_id = selected,
        archive_status = "active",
        query = "Keep in directory",
        limit = 1,
    });
    Check(ThreadIds(refreshed).SequenceEqual([keeper]) && refreshed.GetProperty("selected_archived").GetBoolean()
        && refreshed.GetProperty("selected_available").GetBoolean(),
        "Refreshing must preserve a valid selection and report its updated status even when filters exclude its row.");
    var unverified = await mcp.Tool("handoff_list", new { selected_thread_id = NewId() });
    Check(unverified.GetProperty("selected_archived").ValueKind == JsonValueKind.Null,
        "An unverified selection must not be treated as an active thread.");

    Execute(database, "DROP TABLE thread_spawn_edges");
    var unavailable = await mcp.Tool("handoff_list", new { selected_thread_id = selected });
    Check(!unavailable.GetProperty("spawn_index_available").GetBoolean() && unavailable.GetProperty("selected_archived").GetBoolean()
        && unavailable.GetProperty("items").EnumerateArray().All(item => item.GetProperty("child_note_count").ValueKind == JsonValueKind.Null)
        && ThreadIds(unavailable).ToHashSet().SetEquals([selected, keeper]),
        "An unavailable spawn index must leave verified main notes and selection status readable, with unknown child counts.");
    var unknownChildren = await mcp.Tool("handoff_children", new { thread_id = selected });
    Check(!unknownChildren.GetProperty("spawn_index_available").GetBoolean() && !ThreadIds(unknownChildren).Any(),
        "An unavailable spawn index must explicitly report the child directory as unavailable.");
    var uncertain = await mcp.Tool("handoff_list", new { selected_thread_id = NewId() });
    Check(uncertain.GetProperty("selected_available").ValueKind == JsonValueKind.Null,
        "An unavailable spawn index cannot confirm that a missing group was removed.");
    await mcp.Finish();
}

static async Task VerifyChildDirectory(string home, string panel, string cli)
{
    Directory.CreateDirectory(home);
    await using var mcp = new McpClient(panel, home);
    string main = NewId(), childOnly = NewId(), direct = NewId(), intermediate = NewId(), nested = NewId();
    string fork = NewId(), attached = NewId();
    string database = CreateThreadIndex(home);
    AddThread(database, main, "Main with its own note", null, archived: false, updatedMs: 0);
    AddThread(database, childOnly, "Archived child-only main", null, archived: true, updatedMs: 0);
    AddThread(database, direct, "Direct child", "Task preview", archived: false, updatedMs: 0);
    AddThread(database, intermediate, "Child without a note", null, archived: false, updatedMs: 0);
    AddThread(database, nested, "", null, archived: true, updatedMs: 0);
    AddThread(database, fork, "Ordinary fork", null, archived: false, updatedMs: 0);
    AddThread(database, attached, "Attached thread", null, archived: false, updatedMs: 0);
    Execute(database, """
        UPDATE threads SET agent_nickname = 'Nested reviewer', agent_path = '/root/worker/principal_language' WHERE id = $nested;
        UPDATE threads SET agent_nickname = 'Legacy nickname' WHERE id = $direct;
        UPDATE threads SET attached_thread_parent_id = $main WHERE id = $attached;
        INSERT INTO thread_spawn_edges VALUES ($childOnly, $direct, 'running'), ($childOnly, $intermediate, 'closed'),
            ($intermediate, $nested, 'closed');
        """, ("$main", main), ("$childOnly", childOnly), ("$direct", direct), ("$intermediate", intermediate),
        ("$nested", nested), ("$attached", attached));

    WriteRollout(home, main);
    await SaveNote(cli, home, main, "Main note");
    WriteRollout(home, childOnly, archived: true);
    WriteRollout(home, direct, source: new { subagent = new { thread_spawn = new { parent_thread_id = childOnly } } });
    await SaveNote(cli, home, direct, "Direct note");
    string directUpdatedAt = NoteUpdatedAt(home, direct);
    WriteRollout(home, intermediate, source: new { subagent = new { thread_spawn = new { parent_thread_id = childOnly } } });
    WriteRollout(home, fork, forkedFrom: main);
    await SaveNote(cli, home, fork, "Independent fork note");
    WriteRollout(home, attached, forkedFrom: main, attached: true);
    await SaveNote(cli, home, attached, "Exclude attached note");
    WriteRollout(home, nested, archived: true, source: new { subagent = new { thread_spawn = new { parent_thread_id = intermediate } } });
    await SaveNote(cli, home, nested, "Nested note");
    string nestedUpdatedAt = NoteUpdatedAt(home, nested);

    var groups = await mcp.Tool("handoff_list");
    Check(ThreadIds(groups).SequenceEqual([childOnly, fork, main]), "Only verified main threads should appear in the directory.");
    var group = groups.GetProperty("items")[0];
    Check(group.GetProperty("child_note_count").GetInt32() == 2
        && group.GetProperty("latest_at").GetString() == nestedUpdatedAt
        && group.GetProperty("archived").GetBoolean(),
        "An archived main with only child notes must show the count and newest descendant note time.");
    var childOnlyMainNote = await mcp.Tool("handoff_read", new { thread_id = childOnly });
    Check(childOnlyMainNote.GetProperty("summary").ValueKind == JsonValueKind.Null,
        "A main thread with only child notes must have an empty main note.");
    var own = groups.GetProperty("items")[2];
    Check(own.GetProperty("child_note_count").GetInt32() == 0,
        "A main note must be shown even when it has no child notes.");

    var children = await mcp.Tool("handoff_children", new { thread_id = childOnly, limit = 1 });
    var nestedRow = children.GetProperty("items")[0];
    Check(children.GetProperty("total").GetInt32() == 2 && children.GetProperty("total_pages").GetInt32() == 2
        && ThreadIds(children).SequenceEqual([nested])
        && nestedRow.GetProperty("parent_thread_id").GetString() == intermediate
        && nestedRow.GetProperty("title").GetString() == "/root/worker/principal_language" && nestedRow.GetProperty("archived").GetBoolean(),
        "Child notes must follow nesting through note-less intermediaries and list newest first.");
    var directPage = await mcp.Tool("handoff_children", new { thread_id = childOnly, limit = 1, page = 3 });
    var directRow = directPage.GetProperty("items")[0];
    Check(ThreadIds(directPage).SequenceEqual([direct]) && directPage.GetProperty("page").GetInt32() == 2
        && directRow.GetProperty("parent_thread_id").GetString() == childOnly && directRow.GetProperty("preview").GetString() == "Task preview"
        && directRow.GetProperty("title").ValueKind == JsonValueKind.Null
        && directRow.GetProperty("latest_at").GetString() == directUpdatedAt,
        "A child without a recorded agent path must leave the title empty for the UUID label.");
    var named = await mcp.Tool("handoff_children", new { thread_id = childOnly, query = "/WORKER/PRINCIPAL_LANGUAGE" });
    Check(ThreadIds(named).SequenceEqual([nested]), "Child search must match the canonical path case-insensitively.");
    var noChildren = await mcp.Tool("handoff_children", new { thread_id = main });
    Check(!ThreadIds(noChildren).Any(), "Ordinary forks and attached sessions are outside the spawned child directory.");
    var read = await mcp.Tool("handoff_read", new { thread_id = nested });
    Check(read.GetProperty("summary").GetString() == "Nested note" && read.GetProperty("note_available").GetBoolean(),
        "The standard note reader must open a nested note.");
    await mcp.Finish();
}

static async Task VerifyForkDirectory(string home, string panel, string cli)
{
    Directory.CreateDirectory(home);
    await using var mcp = new McpClient(panel, home);
    string original = NewId(), firstFork = NewId(), secondFork = NewId();
    string originalEarly = NewId(), originalLate = NewId(), originallyEmpty = NewId();
    string forkEarly = NewId(), forkLate = NewId(), own = NewId();
    string database = CreateThreadIndex(home);
    foreach (string root in new[] { original, firstFork, secondFork })
        AddThread(database, root, "Main thread", null, archived: root == original, updatedMs: 0);
    string originalPath = WriteRollout(home, original, archived: true);

    AddChild(originalEarly, original, archived: true, path: "/root/original_reviewer");
    AddChild(originallyEmpty, original);
    await SaveNote(cli, home, originalEarly, "Original note before first fork");
    string firstCutoff = NoteUpdatedAt(home, originalEarly);
    string firstForkPath = WriteRollout(home, firstFork, forkedFrom: original, timestamp: firstCutoff);

    await SaveNote(cli, home, originalEarly, "Post-fork change belongs to original");
    await SaveNote(cli, home, originallyEmpty, "Note first saved after the fork");
    AddChild(originalLate, original);
    await SaveNote(cli, home, originalLate, "Child created after the first fork");

    AddChild(forkEarly, firstFork);
    await SaveNote(cli, home, forkEarly, "First fork note before the second fork");
    string secondCutoff = NoteUpdatedAt(home, forkEarly);
    string secondForkPath = WriteRollout(home, secondFork, forkedFrom: firstFork,
        timestamp: secondCutoff);
    Execute(MemoryDatabase(home), """
        INSERT INTO memory_revisions (thread_id, summary, updated_us, effective_us)
        SELECT thread_id, NULL, updated_us + 1, effective_us + 1 FROM memory_revisions
        WHERE thread_id = $id ORDER BY effective_us DESC, revision DESC LIMIT 1
        """, ("$id", forkEarly));
    AddChild(forkLate, firstFork);
    await SaveNote(cli, home, forkLate, "Child created after the second fork");
    AddChild(own, secondFork);
    await SaveNote(cli, home, own, "Own fork note");

    using (var compressor = new Compressor())
        File.WriteAllBytes(originalPath + ".zst", compressor.Wrap(File.ReadAllBytes(originalPath)).ToArray());
    File.Delete(originalPath);
    string activeSegment = secondForkPath[..^".jsonl".Length] + "_" + NewId() + ".jsonl";
    File.WriteAllText(activeSegment, JsonSerializer.Serialize(new
    {
        type = "session_meta",
        payload = new { id = secondFork, timestamp = "2026-01-01T00:00:00Z", source = "vscode" },
    }) + "\n");
    Execute(database, """
        UPDATE threads SET rollout_path = CASE id WHEN $original THEN $archived WHEN $first THEN $first_path ELSE $active END;
        """, ("$original", original), ("$archived", originalPath), ("$first", firstFork), ("$first_path", firstForkPath),
        ("$active", activeSegment));

    var ownOnly = await mcp.Tool("handoff_children", new { thread_id = secondFork });
    Check(ownOnly.GetProperty("can_include_inherited").GetBoolean() && ThreadIds(ownOnly).SequenceEqual([own])
        && ownOnly.GetProperty("inheritance_status").GetString() == "available"
        && !ownOnly.GetProperty("items")[0].GetProperty("inherited").GetBoolean(),
        "A fork using a later active segment must show only its own notes and still offer inheritance from its original rollout.");

    using (new FileStream(secondForkPath, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        var lockedRoot = await mcp.Tool("handoff_children", new { thread_id = secondFork, include_inherited = true });
        Check(ThreadIds(lockedRoot).SequenceEqual([own]) && lockedRoot.GetProperty("spawn_index_available").GetBoolean()
            && lockedRoot.GetProperty("inheritance_status").GetString() == "unavailable",
            "A locked original fork rollout must keep the fork's own notes and report the unverified ancestry.");
        await CheckAncestryError(forkEarly);
    }

    using (new FileStream(originalPath + ".zst", FileMode.Open, FileAccess.Read, FileShare.None))
    {
        var lockedAncestor = await mcp.Tool("handoff_children", new { thread_id = secondFork, include_inherited = true });
        var directSnapshot = await mcp.Tool("handoff_read", new { thread_id = forkEarly, from_fork = secondFork });
        var afterCutoff = await mcp.Tool("handoff_read", new { thread_id = forkLate, from_fork = secondFork });
        Check(ThreadIds(lockedAncestor).SequenceEqual([own, forkEarly])
            && lockedAncestor.GetProperty("inheritance_status").GetString() == "partial"
            && directSnapshot.GetProperty("summary").GetString() == "First fork note before the second fork"
            && afterCutoff.GetProperty("summary").ValueKind == JsonValueKind.Null,
            "An inaccessible grandparent must keep verified history and known absences for the direct parent.");
        await CheckAncestryError(originalEarly);
    }

    var inherited = await mcp.Tool("handoff_children", new { thread_id = secondFork, include_inherited = true });
    Check(ThreadIds(inherited).SequenceEqual([own, forkEarly, originalEarly])
        && inherited.GetProperty("inheritance_status").GetString() == "available"
        && inherited.GetProperty("items").EnumerateArray().Skip(1).All(row => row.GetProperty("inherited").GetBoolean()
            && row.GetProperty("preview").ValueKind == JsonValueKind.Null),
        "Once the original rollouts can be read, the inherited view must restore every eligible snapshot.");
    var archived = inherited.GetProperty("items")[2];
    Check(archived.GetProperty("archived").GetBoolean() && archived.GetProperty("title").GetString() == "/root/original_reviewer"
        && archived.GetProperty("latest_at").GetString() == firstCutoff,
        "An archived ancestor child must retain its historical note time and agent label.");

    var originalSnapshot = await mcp.Tool("handoff_read", new { thread_id = originalEarly, from_fork = secondFork });
    var forkSnapshot = await mcp.Tool("handoff_read", new { thread_id = forkEarly, from_fork = secondFork });
    var unavailable = await mcp.Tool("handoff_read", new { thread_id = originalLate, from_fork = secondFork });
    var current = await mcp.Tool("handoff_read", new { thread_id = originalEarly });
    var cleared = await mcp.Tool("handoff_read", new { thread_id = forkEarly });
    Check(originalSnapshot.GetProperty("summary").GetString() == "Original note before first fork"
        && forkSnapshot.GetProperty("summary").GetString() == "First fork note before the second fork"
        && unavailable.GetProperty("summary").ValueKind == JsonValueKind.Null
        && cleared.GetProperty("summary").ValueKind == JsonValueKind.Null
        && current.GetProperty("summary").GetString() == "Post-fork change belongs to original",
        "Inherited note reads must use the same ancestry cutoffs as the directory without altering current notes.");

    var unforked = await mcp.Tool("handoff_children", new { thread_id = original, include_inherited = true });
    Check(!unforked.GetProperty("can_include_inherited").GetBoolean() && unforked.GetProperty("total").GetInt32() == 3
        && unforked.GetProperty("inheritance_status").GetString() == "none",
        "A non-forked thread has only notes from its own subagents.");

    File.WriteAllText(secondForkPath, JsonSerializer.Serialize(new
    {
        type = "session_meta",
        payload = new { id = secondFork, timestamp = firstCutoff, source = "vscode", forked_from_id = "invalid" },
    }) + "\n");
    var malformed = await mcp.Tool("handoff_children", new { thread_id = secondFork });
    Check(malformed.GetProperty("inheritance_status").GetString() == "unavailable",
        "A malformed fork link must not classify the thread as an ordinary main thread.");

    Execute(database, "DROP TABLE thread_spawn_edges");
    var unavailableSnapshot = await mcp.Request("tools/call", new
    {
        name = "handoff_read",
        arguments = new { thread_id = originalEarly, from_fork = secondFork },
    });
    Check(unavailableSnapshot.GetProperty("isError").GetBoolean(),
        "An unavailable spawn index must return an error for a historical child read.");
    await mcp.Finish();

    async Task CheckAncestryError(string child)
    {
        var result = await mcp.Request("tools/call", new
        {
            name = "handoff_read",
            arguments = new { thread_id = child, from_fork = secondFork },
        });
        Check(result.GetProperty("isError").GetBoolean()
            && result.GetProperty("content")[0].GetProperty("text").GetString()!.Contains("fork ancestry", StringComparison.OrdinalIgnoreCase),
            "An uncertain ancestor cutoff must return an ancestry error rather than an empty snapshot.");
    }

    void AddChild(string child, string parent, bool archived = false, string? path = null)
    {
        AddThread(database, child, "Live title", "Live task preview", archived, updatedMs: 0);
        Execute(database, """
            UPDATE threads SET agent_nickname = 'Archived nickname', agent_path = $path WHERE id = $child;
            INSERT INTO thread_spawn_edges VALUES ($parent, $child, 'closed');
            """, ("$path", path), ("$child", child), ("$parent", parent));
        WriteRollout(home, child, archived, source: new { subagent = new { thread_spawn = new { parent_thread_id = parent } } });
    }
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
    await SaveNote(cli, home, parent, snapshot);
    string snapshotUpdatedAt = NoteUpdatedAt(home, parent);
    string forkPath = WriteRollout(home, fork, archived: true, forkedFrom: parent, timestamp: snapshotUpdatedAt);
    await SaveNote(cli, home, parent, "Parent note updated after the fork");
    await SaveNote(cli, home, deletedChild, "Deleted subagent's note");
    await SaveNote(cli, home, restored, "Restored after preview");
    await SaveNote(cli, home, archived, "Keep archived notes");
    await RunCli(cli, home, parent, null, "memory", "read", "--thread", archived);
    JsonElement archivePreview = await mcp.Tool("handoff_read", new { thread_id = archived });
    Check(archivePreview.GetProperty("summary").GetString() == "Keep archived notes"
        && archivePreview.GetProperty("last_read_at").ValueKind == JsonValueKind.Null,
        "Cross-thread reads and panel previews must leave the current note's self-read timestamp unset.");
    foreach (string id in new[] { parent, deletedChild, archived })
        await RunCli(cli, home, id, null, "memory", "read");
    var archivedRead = (await mcp.Tool("handoff_read", new { thread_id = archived })).GetProperty("last_read_at");
    Check(archivedRead.ValueKind == JsonValueKind.String && archivedRead.GetDateTimeOffset().Offset == TimeSpan.Zero,
        "A self-read must expose a UTC timestamp to the panel.");
    var indexed = JsonSerializer.Deserialize<JsonElement>(await RunCli(cli, home, null, null,
        "search", "Cache this message", "--rollout", indexedPath, "--since", "2026-01-01T00:00:00Z"));
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
    var result = await mcp.Tool("handoff_cleanup", new { thread_ids = new[] { parent, deletedChild, restored, searchOnly, restored } });
    Check(CleanupIds(result).Order().SequenceEqual(new[] { parent, deletedChild, searchOnly }.Order())
        && result.GetProperty("deleted").GetInt32() >= 3, "Cleanup must revalidate and delete only vanished thread state.");
    Check(result.GetProperty("skipped_thread_count").GetInt32() == 1, "Cleanup must count a surviving confirmed thread only once.");
    Check(File.Exists(archivePath) && File.Exists(forkPath), "Cleanup must not remove Codex rollout files.");
    foreach (string id in new[] { parent, deletedChild })
    {
        var note = await mcp.Tool("handoff_read", new { thread_id = id });
        Check(note.GetProperty("summary").ValueKind == JsonValueKind.Null && !note.GetProperty("note_available").GetBoolean(),
            "Cleanup did not remove a deleted thread note.");
    }
    var removedSelection = await mcp.Tool("handoff_list", new { selected_thread_id = parent });
    Check(!removedSelection.GetProperty("selected_available").GetBoolean(),
        "Refreshing must confirm that the cleaned-up main thread has no remaining note group.");
    var forkNote = await mcp.Tool("handoff_read", new { thread_id = fork });
    Check(forkNote.GetProperty("summary").GetString() == snapshot
        && forkNote.GetProperty("updated_at").GetString() == snapshotUpdatedAt
        && forkNote.GetProperty("last_read_at").ValueKind == JsonValueKind.Null,
        "Cleanup must copy a surviving fork's note as of fork time while leaving its read timestamp unset.");
    foreach (string id in new[] { archived, restored })
    {
        var note = await mcp.Tool("handoff_read", new { thread_id = id });
        Check(note.GetProperty("summary").ValueKind == JsonValueKind.String, "Cleanup removed a surviving archived thread note.");
    }
    var retainedRead = (await mcp.Tool("handoff_read", new { thread_id = archived })).GetProperty("last_read_at");
    Check(retainedRead.GetString() == archivedRead.GetString(),
        "Cleanup must preserve the read timestamp for an archived thread.");
    Check(!CleanupIds(await mcp.Tool("handoff_cleanup")).Any(), "Cleanup left deleted rollout search entries behind.");

    string lateRead = NewId();
    string lateReadRollout = WriteRollout(home, lateRead);
    const string lateReadNote = "Note retrieved before cleanup";
    await SaveNote(cli, home, lateRead, lateReadNote);
    File.Delete(lateReadRollout);
    string memoryPath = MemoryDatabase(home);
    using (var state = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = memoryPath, Pooling = false }.ToString()))
    {
        state.Open();
        using var transaction = state.BeginTransaction(deferred: false);
        using var reader = ChildProcess.Start(cli, home, ["memory", "read"], lateRead);
        reader.StandardInput.Close();
        var stdout = new char[lateReadNote.Length];
        using var readTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        int count = await reader.StandardOutput.ReadBlockAsync(stdout, readTimeout.Token);
        Check(count == stdout.Length && stdout.AsSpan().SequenceEqual(lateReadNote),
            "The note should be returned while the cleanup write transaction is open.");
        using var delete = state.CreateCommand();
        delete.Transaction = transaction;
        delete.CommandText = "DELETE FROM memory_revisions WHERE thread_id = $id";
        delete.Parameters.AddWithValue("$id", lateRead);
        delete.ExecuteNonQuery();
        transaction.Commit();
        await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Check(reader.ExitCode == 0, "The completed read should still succeed after cleanup.");
    }
    Check(!CleanupIds(await mcp.Tool("handoff_cleanup")).Contains(lateRead),
        "A completed read must not recreate metadata for a note removed by cleanup.");

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
        && !kept.TryGetProperty("skipped_thread_count", out _)
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
            first_user_message TEXT, source TEXT NOT NULL DEFAULT 'vscode', thread_source TEXT, agent_nickname TEXT, agent_role TEXT, agent_path TEXT,
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

static Task SaveNote(string cli, string home, string id, string note) =>
    RunCli(cli, home, id, note, "memory", "write");

static string MemoryDatabase(string home) =>
    Path.Combine(home, "state", "plugins", "thread-memory", "handoff.sqlite3");

static string NoteUpdatedAt(string home, string id)
{
    using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
    {
        DataSource = MemoryDatabase(home), Mode = SqliteOpenMode.ReadOnly, Pooling = false,
    }.ToString());
    connection.Open();
    using var command = connection.CreateCommand();
    command.CommandText = "SELECT updated_us FROM memory_revisions WHERE thread_id = $id ORDER BY revision DESC LIMIT 1";
    command.Parameters.AddWithValue("$id", id);
    if (command.ExecuteScalar() is not long updatedUs)
        throw new InvalidOperationException("The note update time was not persisted.");
    return DateTime.UnixEpoch.AddTicks(checked(updatedUs * 10))
        .ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture);
}

static async Task<string> RunCli(string cli, string home, string? id, string? input, params string[] arguments)
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
    return await output;
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
