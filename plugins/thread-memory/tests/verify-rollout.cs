using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

if (args.Length > 1)
{
    Console.Error.WriteLine("Usage: dotnet run --file verify-rollout.cs -- [Thread-Memory.exe]");
    return 2;
}

string cli = Path.GetFullPath(args.FirstOrDefault()
    ?? Environment.GetEnvironmentVariable("THREAD_MEMORY_TEST_CLI_EXE") ?? PackagedCli());
if (!File.Exists(cli))
{
    Console.Error.WriteLine("Thread-Memory.exe was not found. Build the Native AOT CLI or pass its path.");
    return 2;
}

string home = Directory.CreateTempSubdirectory("thread-memory-rollout-").FullName;
string sessions = Directory.CreateDirectory(Path.Combine(home, "sessions")).FullName;
var utf8 = new UTF8Encoding(false, true);

try
{
    await Help();
    Console.WriteLine("Passed rollout quick-start examples and command help.");
    await IndexedHistory();
    Console.WriteLine("Passed scoped history, references, and latest messages after append.");
    await MarkdownSearch();
    Console.WriteLine("Passed Markdown search, JSON defaults, references, pagination, and file output.");
    await UnicodeSearch();
    Console.WriteLine("Passed Unicode regex hits and reference round-trips.");
    await ForkHistory();
    Console.WriteLine("Passed physical fork cutoff and copied subagent provenance.");
    await LegacyForkRecovery();
    Console.WriteLine("Passed legacy fork recovery and history origin scopes.");
    await DamagedHistory();
    Console.WriteLine("Passed salvage pagination, physical offsets, and UTF-8.");
    await ToolDetails();
    Console.WriteLine("Passed tool metadata privacy, typed JSON values, and line-range reads.");
    await CompactionRecovery();
    Console.WriteLine("Passed recovery of generated images and asynchronous assistant messages.");
    return 0;
}
catch (Exception error) when (error is IOException or UnauthorizedAccessException or
    InvalidOperationException or JsonException or KeyNotFoundException or TimeoutException)
{
    Console.Error.WriteLine($"Rollout verification failed. {error.Message}");
    return 1;
}
finally
{
    Directory.Delete(home, recursive: true);
}

async Task Help()
{
    const string expandHit = "read --ref REF";
    string thread = Guid.NewGuid().ToString();
    var overview = await Invoke(thread, ["--help"]);
    Require(overview.Status == 0 && overview.Error.Length == 0, "Overview help should succeed without a rollout.");
    int commands = overview.Output.IndexOf("Commands:", StringComparison.Ordinal);
    foreach (string example in new[] { "transcript --last 6", "search \"phrase\" --limit 5", expandHit })
    {
        int offset = overview.Output.IndexOf($"Thread-Memory {example}", StringComparison.Ordinal);
        Require(offset >= 0 && offset < commands, $"Overview should show '{example}' before the command list.");
    }

    var transcript = await Invoke(thread, ["transcript", "--help"]);
    Require(transcript.Status == 0 && transcript.Error.Length == 0 &&
        transcript.Output.Contains("Thread-Memory transcript --last 6", StringComparison.Ordinal),
        "Transcript help should show how to read recent chat.");
    var search = await Invoke(thread, ["search", "--help"]);
    Require(search.Status == 0 && search.Error.Length == 0 &&
        search.Output.Contains("--format", StringComparison.Ordinal) &&
        search.Output.Contains("markdown", StringComparison.Ordinal) &&
        search.Output.Contains(".items[].text", StringComparison.Ordinal) &&
        search.Output.Contains($"Thread-Memory {expandHit}", StringComparison.Ordinal),
        "Search help should show how to choose an output format, inspect an excerpt, and expand a hit.");
    var read = await Invoke(thread, ["read", "--help"]);
    Require(read.Status == 0 && read.Error.Length == 0 &&
        read.Output.Contains($"Thread-Memory {expandHit}", StringComparison.Ordinal) &&
        read.Output.Contains(".items[].fields[].text", StringComparison.Ordinal) &&
        read.Output.Contains("400 characters, or 1000 with --ref", StringComparison.Ordinal),
        "Read help should show how to request and locate a longer excerpt.");
}

async Task IndexedHistory()
{
    string thread = Guid.NewGuid().ToString();
    string path = RolloutPath(sessions, thread);
    string target = "needle target \u68c0\u7d22 " + new string('x', 1200) + " end of target \U0001f680";
    string[] records =
    [
        Record(1, "session_meta", new JsonObject { ["id"] = thread, ["cwd"] = home }),
        Message(2, "needle before checkpoint"),
        Checkpoint(3, 4),
        Record(4, "event_msg", new JsonObject { ["type"] = "turn_started", ["turn_id"] = "selected-turn" }),
        Message(5, target),
        Checkpoint(6, 9),
        Message(7, "needle in current window"),
    ];
    File.WriteAllText(path, string.Concat(records), utf8);
    JsonElement search = await Query(thread, ["search", "needle", "--window", "9"]);
    ExpectLines(search, 5);
    Require(File.Exists(Path.Combine(home, "state", "plugins", "thread-memory", "rollout-index.sqlite3")),
        "A time- or window-scoped search did not prepare the rollout index.");
    JsonElement hit = Item(search);
    string reference = hit.GetProperty("ref").GetString()!;
    Require(hit.GetProperty("text_truncated").GetBoolean() && hit.GetProperty("text").GetString() == target[..400],
        "Search should return 400 characters by default for the long hit.");
    JsonElement record = Item(await Query(thread, ["read", "--lines", "5:5"]));
    Require(record.GetProperty("fields")[0].GetProperty("text").GetString() == target[..400],
        "Read without a reference should still return 400 characters by default.");

    JsonElement timed = await Query(thread, ["search", "needle", "--since", "2026-01-01T08:00:05+08:00",
        "--until", Stamp(7), "--turn", "selected-turn"]);
    ExpectLines(timed, 5);
    JsonElement windows = await Query(thread, ["windows", "--window", "current"]);
    Require(Item(windows).GetProperty("start").GetProperty("line").GetInt64() == 7 &&
        Item(windows).GetProperty("compacted_at").ValueKind == JsonValueKind.Null,
        "The open window did not start after the last compaction.");
    ExpectLines(await Query(thread, ["transcript", "--last", "2"]), 5, 7);

    File.AppendAllText(path, Message(8, "newly appended") + """{"type":""", utf8);
    JsonElement read = Item(await Query(thread, ["read", "--ref", "-"], reference + "\n"));
    Require(read.GetProperty("line").GetInt64() == 5 &&
        read.GetProperty("fields")[0].GetProperty("text").GetString() == target[..1000],
        "A reference from stdin should reopen its record after append with a 1000-character excerpt.");
    JsonElement tailHit = Item(await Query(thread, ["search", "end of target", "--window", "9"]));
    string tailRef = tailHit.GetProperty("ref").GetString()!;
    int totalChars = target.EnumerateRunes().Count();
    int tailOffset = totalChars - 1000;
    JsonElement expanded = Item(await Query(thread, ["read", "--ref", tailRef]));
    JsonElement expandedField = expanded.GetProperty("fields")[0];
    Require(expandedField.GetProperty("text_offset").GetInt32() == tailOffset &&
        expandedField.GetProperty("text").GetString() == target[tailOffset..],
        "A reference for a hit near the end should reopen the last 1000 characters.");
    Require(expanded.GetProperty("text_truncated").GetBoolean(),
        "An automatic excerpt that reaches the end but omits the prefix must report truncation.");

    JsonElement full = Item(await Query(thread, ["read", "--ref", tailRef, "--max-chars", "1500"]));
    Require(!full.GetProperty("text_truncated").GetBoolean() &&
        full.GetProperty("fields")[0].GetProperty("text").GetString() == target,
        "An explicit --max-chars should override the reference default and return the whole field without truncation.");

    string tailRange = FormattableString.Invariant($"{tailOffset}:{totalChars}");
    JsonElement slice = Item(await Query(thread, ["read", "--ref", tailRef, "--chars", tailRange]));
    Require(!slice.GetProperty("text_truncated").GetBoolean() &&
        slice.GetProperty("fields")[0].GetProperty("text").GetString() == target[tailOffset..],
        "A complete explicit slice must not report truncation just because it omitted the prefix.");
    JsonElement clipped = Item(await Query(thread, ["read", "--ref", tailRef, "--chars", tailRange, "--budget-chars", "999"]));
    Require(clipped.GetProperty("text_truncated").GetBoolean() &&
        clipped.GetProperty("fields")[0].GetProperty("text").GetString() == target[tailOffset..^2],
        "An explicit slice larger than the page budget must report truncation.");
    ExpectLines(await Query(thread, ["transcript", "--window", "current", "--last", "2"]), 7, 8);

    records[4] = Message(5, "rewritten");
    File.WriteAllText(path, string.Concat(records), utf8);
    await ExpectError(thread, ["read", "--ref", reference], "invalid_input");
}

async Task MarkdownSearch()
{
    const string pattern = "markdown needle";
    const string context = "previous context excerpt";
    string target = $"{pattern} \u68c0\u7d22 \U0001f680\u001b\r\n````\n## Match 999\n<em>literal</em>\n" + new string('x', 100);
    string thread = Guid.NewGuid().ToString();
    string path = RolloutPath(sessions, thread);
    File.WriteAllText(path,
        Record(1, "session_meta", new JsonObject { ["id"] = thread }) + Message(2, context) +
        Message(3, target) + Message(4, $"{pattern} on next page"), utf8);

    string[] search = ["search", pattern, "--limit", "1", "--before", "1", "--max-chars", "80", "--budget-chars", "92"];
    var json = await Invoke(thread, search);
    var explicitJson = await Invoke(thread, [.. search, "--format", "json"]);
    Require(json.Status == 0 && explicitJson.Status == 0 && json.Error.Length == 0 && explicitJson.Error.Length == 0 &&
        json.Output == explicitJson.Output, "Omitting --format must produce the same JSON as --format json.");
    JsonElement page = JsonElement.Parse(json.Output);
    ExpectLines(page, 3);
    JsonElement hit = Item(page);

    string[] markdownSearch = [.. search, "--format", "markdown"];
    var markdown = await Invoke(thread, markdownSearch);
    Require(markdown.Status == 0 && markdown.Error.Length == 0 &&
        markdown.Output.StartsWith("# Codex rollout search\n", StringComparison.Ordinal) &&
        markdown.Output.Contains("## Match 1\n", StringComparison.Ordinal) &&
        markdown.Output.Contains($"Source: `{path}:3`", StringComparison.Ordinal) &&
        markdown.Output.Contains("[Excerpt truncated.]", StringComparison.Ordinal),
        "Markdown should show the hit's physical location and warn when its excerpt is truncated.");
    string[] lines = markdown.Output.Split('\n');
    int openFence = Array.FindIndex(lines, line => line.Length > 4 && line.All(ch => ch == '`'));
    int closeFence = openFence < 0 ? -1 : Array.IndexOf(lines, lines[openFence], openFence + 1);
    string excerpt = hit.GetProperty("text").GetString()!
        .Replace("\r\n", "\n", StringComparison.Ordinal).Replace("\u001b", @"\u001b", StringComparison.Ordinal);
    Require(excerpt.Contains("\n````\n## Match 999\n<em>literal</em>\n", StringComparison.Ordinal) &&
        openFence >= 0 && closeFence > openFence && string.Join('\n', lines[(openFence + 1)..closeFence]) == excerpt,
        "A multiline excerpt must fence literal Markdown and HTML, normalize CRLF, and display escapes as text.");

    string expectedReference = hit.GetProperty("ref").GetString()!;
    Require(lines.Contains($"Ref: `{expectedReference}`"), "The Markdown hit reference must match the JSON reference.");
    JsonElement reopened = Item(await Query(thread, ["read", "--ref", expectedReference]));
    Require(reopened.GetProperty("fields")[0].GetProperty("text").GetString() == target,
        "The displayed hit reference should reopen the original text.");
    Require(page.GetProperty("context_truncated").GetBoolean() &&
        markdown.Output.Contains("## Context\n", StringComparison.Ordinal) &&
        markdown.Output.Contains(context[..12], StringComparison.Ordinal) &&
        markdown.Output.Contains("[Context was limited by the text budget.]", StringComparison.Ordinal) &&
        !markdown.Output.Contains(context, StringComparison.Ordinal),
        "Markdown should show separate context excerpts with a warning if limited by the same text budget as JSON.");

    const string cursorLabel = "Next cursor: ";
    string? cursorLine = lines.LastOrDefault(line => line.StartsWith(cursorLabel, StringComparison.Ordinal));
    Require(cursorLine is not null, "A Markdown page with more matches should show a cursor.");
    string cursor = cursorLine![cursorLabel.Length..];
    Require(cursor == page.GetProperty("next_cursor").GetString(), "The Markdown cursor must match the JSON cursor.");
    var nextPage = await Invoke(thread, [.. markdownSearch, "--cursor", cursor]);
    Require(nextPage.Status == 0 && nextPage.Error.Length == 0 &&
        nextPage.Output.Contains($"Source: `{path}:4`", StringComparison.Ordinal) &&
        nextPage.Output.Contains($"{pattern} on next page", StringComparison.Ordinal) &&
        !nextPage.Output.Contains(cursorLabel, StringComparison.Ordinal),
        "The displayed cursor should continue from the next hit and stop when there are no more matches.");

    string output = Path.Combine(home, "search.md");
    JsonElement receipt = await Query(thread, [.. markdownSearch, "--output", output]);
    byte[] written = File.ReadAllBytes(output);
    Require(written.SequenceEqual(utf8.GetBytes(markdown.Output)) &&
        receipt.GetProperty("output").GetString() == output &&
        receipt.GetProperty("bytes").GetInt64() == written.LongLength &&
        receipt.GetProperty("next_cursor").GetString() == cursor,
        "Writing Markdown should preserve its UTF-8 bytes and return the usual JSON output receipt.");

    var empty = await Invoke(thread, ["search", "absent phrase", "--format", "markdown"]);
    Require(empty.Status == 0 && empty.Error.Length == 0 && empty.Output.Contains("No matches.", StringComparison.Ordinal)
        && !empty.Output.Contains(cursorLabel, StringComparison.Ordinal),
        "A successful search without hits should show an empty-page message and no cursor.");

    string damagedPath = Path.Combine(home, "rollout-[x](y)\u009b.jsonl");
    File.WriteAllText(damagedPath, Record(1, "session_meta", new JsonObject { ["id"] = thread }) +
        "{\"type\":\"response_item\",\"payload\":{\n" + Message(3, pattern), utf8);
    var salvage = await Invoke(thread, ["search", pattern, "--rollout", damagedPath, "--format", "markdown", "--salvage"]);
    string visiblePath = damagedPath.Replace("\u009b", @"\u009b", StringComparison.Ordinal);
    Require(salvage.Status == 0 && salvage.Error.Length == 0 && !salvage.Output.Contains('\u009b') &&
        salvage.Output.Contains($"Source: `{visiblePath}:3`", StringComparison.Ordinal) &&
        salvage.Output.Contains("Damaged records observed: 1\n", StringComparison.Ordinal) &&
        salvage.Output.Contains($"\n- `{visiblePath}:2`, byte ", StringComparison.Ordinal),
        "Markdown should escape path controls and show literal paths in both hit locations and salvage warnings.");
}

async Task UnicodeSearch()
{
    const string glyph = "\U00020bb7";
    string thread = Guid.NewGuid().ToString();
    File.WriteAllText(RolloutPath(sessions, thread),
        Record(1, "session_meta", new JsonObject { ["id"] = thread }) + Message(2, $"A{glyph}Z"), utf8);

    string? reference = null;
    foreach (string pattern in new[] { ".(?=Z$)", "(?<=A).", $"{glyph}(?=Z$)" })
    {
        JsonElement hit = Item(await Query(thread, ["search", "--regex", pattern, "--max-chars", "1"]));
        Require(hit.GetProperty("match_start").GetInt32() == 1 && hit.GetProperty("match_end").GetInt32() == 2 &&
            hit.GetProperty("text_offset").GetInt32() == 1 && hit.GetProperty("text").GetString() == glyph,
            $"A non-empty regex match for '{pattern}' must cover the complete Unicode character.");
        string hitRef = hit.GetProperty("ref").GetString()!;
        reference ??= hitRef;
        Require(hitRef == reference, "Regex matches covering the same Unicode range should produce the same reference.");
    }

    JsonElement reopened = Item(await Query(thread, ["read", "--ref", reference!, "--max-chars", "1"]));
    Require(reopened.GetProperty("match_start").GetInt32() == 1 && reopened.GetProperty("match_end").GetInt32() == 2 &&
        reopened.GetProperty("fields")[0].GetProperty("text").GetString() == glyph,
        "A regex hit reference should reopen the complete Unicode character at the same range.");

    foreach (string pattern in new[] { "(?=Z$)", @"(?=\uDFB7)" })
    {
        JsonElement empty = Item(await Query(thread, ["search", "--regex", pattern, "--max-chars", "1"]));
        Require(empty.GetProperty("match_start").GetInt32() == 2 && empty.GetProperty("match_end").GetInt32() == 2,
            $"A zero-width regex hit for '{pattern}' must preserve its empty range.");
    }
}

async Task ForkHistory()
{
    string parent = Guid.NewGuid().ToString();
    string child = Guid.NewGuid().ToString();
    string archive = Directory.CreateDirectory(Path.Combine(home, "archived_sessions")).FullName;
    string parentPrefix = Record(1, "session_meta", new JsonObject { ["id"] = parent }) + Message(2, "before fork");
    File.WriteAllText(RolloutPath(archive, parent), parentPrefix + Message(3, "parent updated later"), utf8);
    File.WriteAllText(RolloutPath(sessions, child), Record(3, "session_meta", new JsonObject
    {
        ["id"] = child,
        ["forked_from_id"] = parent,
        ["history_base"] = new JsonObject
        {
            ["thread_id"] = parent,
            ["end_ordinal_exclusive"] = 3,
            ["end_byte_offset"] = utf8.GetByteCount(parentPrefix),
        },
    }) + Message(4, "owned by fork"), utf8);

    JsonElement fork = await Query(child, ["transcript"]);
    ExpectLines(fork, 2, 2);
    var inherited = Item(fork);
    Require(inherited.GetProperty("text").GetString() == "before fork" &&
        inherited.GetProperty("thread_id").GetString() == parent &&
        inherited.GetProperty("origin").GetString() == "inherited" &&
        Item(fork, 1).GetProperty("origin").GetString() == "current",
        "Fork transcript included the wrong history or provenance.");
    ExpectLines(await Query(child, ["transcript", "--origin", "current"]), 2);

    string subagent = Guid.NewGuid().ToString();
    File.WriteAllText(RolloutPath(sessions, subagent), Record(1, "session_meta", new JsonObject
    {
        ["id"] = subagent,
        ["forked_from_id"] = parent,
        ["parent_thread_id"] = child,
        ["subagent_history_start_ordinal"] = 3,
    }) + Message(2, "copied to subagent") + Message(3, "owned by subagent"), utf8);
    JsonElement copied = await Query(subagent, ["transcript", "--origin", "inherited"]);
    ExpectLines(copied, 2);
    Require(Item(copied).GetProperty("forked_from_thread_id").GetString() == parent &&
        Item(copied).GetProperty("timestamp_origin").GetString() == "copied_at",
        "The copied message did not identify its original thread and copied timestamp.");
}

async Task LegacyForkRecovery()
{
    string parent = Guid.NewGuid().ToString();
    string child = Guid.NewGuid().ToString();
    JsonNode copy = JsonNode.Parse(Message(2, "marked as copied"))!;
    copy["metadata"] = new JsonObject { ["inherited_user_message"] = true };
    string path = RolloutPath(sessions, child);
    File.WriteAllText(path, Record(1, "session_meta", new JsonObject
    {
        ["id"] = child, ["forked_from_id"] = parent, ["cwd"] = home,
    }) + copy.ToJsonString() + "\n" +
        Settings(3, parent) +
        Record(4, "event_msg", new JsonObject { ["type"] = "turn_started", ["turn_id"] = "parent-turn" }) +
        Message(5, "ambiguous prefix") +
        Checkpoint(6, 4) +
        Settings(7, child) +
        Message(8, "owned message before compaction") +
        Record(9, "compacted", new JsonObject { ["window_number"] = 5, ["replacement_history"] = new JsonArray() }),
        utf8);

    JsonElement recovery = await Query(child, ["recover"]);
    var messages = recovery.GetProperty("messages");
    Require(recovery.GetProperty("status").GetString() == "ok" &&
        recovery.GetProperty("compaction_line").GetInt32() == 9 &&
        messages.GetArrayLength() == 1 && messages[0].GetProperty("line").GetInt32() == 8,
        "Recovery did not select the legacy fork's own compaction and its missing message.");
    JsonElement owned = await Query(child, ["transcript", "--origin", "current", "--since", Stamp(3)]);
    ExpectLines(owned, 8);
    Require(Item(owned).GetProperty("turn_id").ValueKind == JsonValueKind.Null,
        "The fork's own message was attributed to a turn from the copied prefix.");
    ExpectLines(await Query(child, ["transcript", "--origin", "inherited"]), 2);
    ExpectLines(await Query(child, ["transcript", "--origin", "unknown"]), 5);

    static string Settings(int line, string thread) => Record(line, "event_msg", new JsonObject
    {
        ["type"] = "thread_settings_applied", ["thread_id"] = thread,
    });
}

async Task DamagedHistory()
{
    string thread = Guid.NewGuid().ToString();
    string path = RolloutPath(sessions, thread);
    string question = "\u95ee\u9898";
    string answer = "\u56de\u590d \U0001f680";
    string prefix = Record(1, "session_meta", new JsonObject { ["id"] = thread }) + Message(2, question);
    const string broken = "{\"type\":\"response_item\",\"payload\":{\n";
    string oldMessage = Message(4, "old SURROGATE").Replace("SURROGATE", @"\ud800", StringComparison.Ordinal);
    string valid = prefix + broken + oldMessage + Message(5, answer);
    File.WriteAllText(path, valid + """{"type":""", utf8);

    await ExpectError(thread, ["transcript"], "invalid_rollout", line: 3);
    JsonElement first = await Query(thread, ["transcript", "--salvage", "--limit", "2"]);
    ExpectLines(first, 2, 4);
    Require(Item(first).GetProperty("text").GetString() == question &&
        Item(first, 1).GetProperty("text").GetString() == "old \ufffd",
        "Unicode text or a legacy surrogate was rendered incorrectly.");
    string cursor = first.GetProperty("next_cursor").GetString()
        ?? throw new InvalidOperationException("The first salvage page did not return a cursor.");
    JsonElement second = await Query(thread, ["transcript", "--salvage", "--limit", "2", "--cursor", "-"],
        cursor + "\r\n");
    ExpectLines(second, 5);
    Require(Item(second).GetProperty("text").GetString() == answer &&
        second.GetProperty("next_cursor").ValueKind == JsonValueKind.Null,
        "The continuation did not return the last UTF-8 message.");
    JsonElement damage = second.GetProperty("damaged_records").GetProperty("items");
    Require(damage.GetArrayLength() == 2 &&
        damage[0].GetProperty("line").GetInt32() == 3 &&
        damage[0].GetProperty("byte_offset").GetInt32() == utf8.GetByteCount(prefix) &&
        damage[0].GetProperty("reason").GetString() == "invalid_json" &&
        damage[1].GetProperty("line").GetInt32() == 6 &&
        damage[1].GetProperty("reason").GetString() == "partial_tail",
        "Salvage did not distinguish malformed records from an incomplete tail.");

    File.WriteAllText(path, valid.TrimEnd('\n'), utf8);
    JsonElement completeTail = await Query(thread, ["transcript", "--salvage", "--last", "1"]);
    ExpectLines(completeTail, 5);
    Require(completeTail.GetProperty("damaged_records").GetProperty("count").GetInt32() == 1,
        "A valid final line without a terminator was reported as damaged.");
}

async Task ToolDetails()
{
    string thread = Guid.NewGuid().ToString();
    const string privateArgument = "only-visible-to-tool-input";
    const string privateOutput = "only-visible-to-tool-output";
    const string outputLine = "\u8f93\u51fa \U0001f680";
    File.WriteAllText(RolloutPath(sessions, thread),
        Record(1, "session_meta", new JsonObject { ["id"] = thread }) +
        Record(2, "response_item", new JsonObject
        {
            ["type"] = "function_call", ["name"] = "exec_command", ["call_id"] = "call-verify",
            ["arguments"] = """{"cmd":"only-visible-to-tool-input","nested":[true,"\u6821\u9a8c",3]}""",
        }) +
        Record(3, "response_item", new JsonObject
        {
            ["type"] = "function_call_output", ["call_id"] = "call-verify",
            ["output"] = $"{privateOutput}\n{outputLine}\nlast line",
        }), utf8);

    JsonElement metadata = await Query(thread, ["search", "call-verify", "--tool", "exec_command"]);
    ExpectLines(metadata, 2, 3);
    foreach ((JsonElement row, string hidden) in new[] { (Item(metadata), privateArgument), (Item(metadata, 1), privateOutput) })
    {
        Require(!row.GetRawText().Contains(hidden, StringComparison.Ordinal), "Tool metadata leaked a body.");
        string reference = row.GetProperty("ref").GetString()!;
        JsonElement reopened = await Query(thread, ["read", "--ref", "-"], reference + "\n");
        Require(!reopened.GetRawText().Contains(hidden, StringComparison.Ordinal), "A generic reference leaked a tool body.");
    }

    string inputId = Item(metadata).GetProperty("input_id").GetString()!;
    JsonElement value = (await Query(thread, ["tool-input", "--id", "-", "--pointer", "/arguments/nested"],
        inputId + "\n")).GetProperty("value");
    Require(value.GetArrayLength() == 3 && value[0].GetBoolean() &&
        value[1].GetString() == "\u6821\u9a8c" && value[2].GetInt32() == 3,
        "The tool input pointer did not preserve JSON value types.");
    string outputId = Item(metadata, 1).GetProperty("output_id").GetString()!;
    JsonElement details = await Query(thread, ["tool-output", "--id", "-", "--lines", "2:2"], outputId + "\n");
    Require(details.GetProperty("items").GetArrayLength() == 1 &&
        Item(details).GetProperty("text").GetString() == outputLine + "\n" &&
        details.GetProperty("next_cursor").ValueKind == JsonValueKind.Null,
        "The direct tool output range returned the wrong line.");
}

async Task CompactionRecovery()
{
    const string imageData = "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAGCAYAAAD37n+BAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAWSURBVChTY/i/lOE/KZgBXYAQHg4aACHFvdn3n82xAAAAAElFTkSuQmCC";
    const string retainedImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/OeYAAAAASUVORK5CYII=";
    const string retainedMessage = "Message carried forward";
    string thread = Guid.NewGuid().ToString();
    string localImage = Path.Combine(home, "local-image.png");
    File.WriteAllBytes(localImage, Convert.FromBase64String(imageData));
    File.WriteAllText(RolloutPath(sessions, thread),
        Record(1, "session_meta", new JsonObject { ["id"] = thread }) +
        Record(2, "event_msg", Completed("Asynchronous assistant message")) +
        Record(3, "event_msg", new JsonObject
        {
            ["type"] = "agent_message", ["delivery"] = "async", ["message"] = "Legacy asynchronous message",
        }) +
        Record(4, "event_msg", Completed(retainedMessage)) +
        Record(5, "response_item", Generated(imageData)) +
        Record(6, "response_item", Generated(retainedImage)) +
        Record(7, "response_item", new JsonObject
        {
            ["type"] = "function_call_output", ["call_id"] = "call-image",
            ["output"] = new JsonArray(new JsonObject { ["type"] = "input_image", ["image_url"] = localImage }),
        }) +
        Record(8, "compacted", new JsonObject
        {
            ["window_number"] = 1,
            ["replacement_history"] = new JsonArray(new JsonObject
            {
                ["type"] = "message", ["role"] = "assistant",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = retainedMessage }),
            }, new JsonObject
            {
                ["type"] = "message", ["role"] = "user",
                ["content"] = new JsonArray(new JsonObject
                {
                    ["type"] = "input_image", ["image_url"] = "data:image/png;base64," + retainedImage,
                }),
            }),
        }), utf8);

    JsonElement recovery = await Query(thread, ["recover"]);
    Require(recovery.GetProperty("status").GetString() == "ok" && recovery.GetProperty("candidate_count").GetInt32() == 2,
        "Recovery did not count exactly the missing asynchronous messages.");
    JsonElement messages = recovery.GetProperty("messages");
    Require(messages.EnumerateArray().Select(message => message.GetProperty("line").GetInt32()).SequenceEqual([2, 3])
        && messages[0].GetProperty("text").GetString() == "Asynchronous assistant message"
        && messages[1].GetProperty("text").GetString() == "Legacy asynchronous message"
        && messages.EnumerateArray().All(message => message.GetProperty("role").GetString() == "assistant"),
        "Recovery did not return the original asynchronous assistant records.");
    JsonElement images = recovery.GetProperty("image_records");
    Require(recovery.GetProperty("image_candidate_count").GetInt32() == 1 &&
        images.GetArrayLength() == 1 && images[0].GetProperty("line").GetInt32() == 5,
        "Recovery did not return exactly the generated image missing from the replacement history.");
    JsonElement locals = recovery.GetProperty("local_images");
    Require(recovery.GetProperty("local_image_candidate_count").GetInt32() == 1 && locals.GetArrayLength() == 1 &&
        locals[0].GetProperty("line").GetInt32() == 7 && locals[0].GetProperty("path").GetString() == localImage &&
        locals[0].GetProperty("thread_id").GetString() == thread && locals[0].GetProperty("origin").GetString() == "current",
        "Recovery did not preserve the source of the local attachment.");
    string imageId = images[0].GetProperty("images")[0].GetProperty("image_id").GetString()!;
    string exportDir = Path.Combine(home, "recovered-images");
    JsonElement export = await Query(thread, ["export-image", "--id", imageId, "--original", "--output-dir", exportDir]);
    string imagePath = export.GetProperty("images")[0].GetProperty("original_file").GetString()!;
    Require(File.ReadAllBytes(imagePath).SequenceEqual(Convert.FromBase64String(imageData)),
        "The recovered image ID did not export the original bytes.");

    static JsonObject Completed(string text) => new()
    {
        ["type"] = "item_completed",
        ["item"] = new JsonObject
        {
            ["type"] = "AgentMessage", ["delivery"] = "async", ["phase"] = "final_answer",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "Text", ["text"] = text }),
        },
    };

    static JsonObject Generated(string result) => new()
    {
        ["type"] = "image_generation_call", ["status"] = "completed", ["result"] = result,
    };
}

async Task<JsonElement> Query(string thread, string[] arguments, string? stdin = null)
{
    var result = await Invoke(thread, arguments, stdin);
    Require(result.Status == 0 && result.Error.Length == 0,
        $"{arguments[0]} should succeed with JSON stdout. Exit {result.Status}. {result.Error}");
    return JsonElement.Parse(result.Output);
}

async Task ExpectError(string thread, string[] arguments, string code, int? line = null)
{
    var result = await Invoke(thread, arguments);
    Require(result.Status == 1 && result.Output.Length == 0,
        $"{arguments[0]} should fail with JSON stderr. Exit {result.Status}.");
    JsonElement error = JsonElement.Parse(result.Error).GetProperty("error");
    Require(error.GetProperty("code").GetString() == code &&
        (line is null || error.GetProperty("line").GetInt32() == line),
        $"Expected {code} at line {line?.ToString() ?? "(any)"}. Got {result.Error}");
}

async Task<(int Status, string Output, string Error)> Invoke(string thread, string[] arguments, string? stdin = null)
{
    var start = new ProcessStartInfo(cli)
    {
        WorkingDirectory = home, UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        StandardInputEncoding = utf8, StandardOutputEncoding = utf8, StandardErrorEncoding = utf8,
    };
    start.Environment["CODEX_HOME"] = home;
    start.Environment["CODEX_SQLITE_HOME"] = home;
    start.Environment["CODEX_THREAD_ID"] = thread;
    foreach (string argument in arguments)
        start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new InvalidOperationException("The CLI did not start.");
    Task<string> output = process.StandardOutput.ReadToEndAsync();
    Task<string> error = process.StandardError.ReadToEndAsync();
    if (stdin is not null)
        await process.StandardInput.WriteAsync(stdin);
    process.StandardInput.Close();
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    try
    {
        await process.WaitForExitAsync(deadline.Token);
    }
    catch (OperationCanceledException) when (deadline.IsCancellationRequested)
    {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
        throw new TimeoutException($"{arguments[0]} timed out.");
    }
    return (process.ExitCode, await output, await error);
}

static string Record(int line, string type, JsonObject payload) => new JsonObject
{
    ["timestamp"] = Stamp(line), ["ordinal"] = line, ["type"] = type, ["payload"] = payload,
}.ToJsonString() + "\n";

static string Message(int line, string text) => Record(line, "response_item", new JsonObject
{
    ["type"] = "message", ["role"] = "user",
    ["content"] = new JsonArray(new JsonObject { ["type"] = "input_text", ["text"] = text }),
});

static string Checkpoint(int line, int window) => Record(line, "compacted", new JsonObject { ["window_number"] = window });

static string Stamp(int line) => FormattableString.Invariant($"2026-01-01T00:00:{line:00}Z");

static string RolloutPath(string directory, string thread) =>
    Path.Combine(directory, $"rollout-2026-01-01T00-00-00-{thread}.jsonl");

static JsonElement Item(JsonElement page, int index = 0) => page.GetProperty("items")[index];

static void ExpectLines(JsonElement page, params int[] lines)
{
    int[] actual = page.GetProperty("items").EnumerateArray().Select(item => item.GetProperty("line").GetInt32()).ToArray();
    Require(actual.SequenceEqual(lines),
        $"Expected lines [{string.Join(", ", lines)}]. Got [{string.Join(", ", actual)}].");
}

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static string PackagedCli([CallerFilePath] string source = "") =>
    Path.Combine(Path.GetDirectoryName(source)!, "..", "bin", "Thread-Memory.exe");
