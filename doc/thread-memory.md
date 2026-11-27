# Thread Memory

Use `$thread-memory` to maintain thread notes across context compaction in main threads and subagents. Main-thread forks get an independent copy of the note as of their creation time. Subagents start with an empty note, including when they inherit chat history. The Native AOT CLI also locates compaction windows, searches local rollout history, and retrieves selected tool details and attachments by ID. It opens Codex state and rollout files read-only. Thread notes and reminder claims live in plugin SQLite storage.

## CLI help

Run `--help` to list commands. Add it to a command or memory subcommand to see its accepted options, defaults, output, and an example. From the repository root in PowerShell 7:

```powershell
$cli = (Resolve-Path 'plugins/thread-memory/bin/Thread-Memory.exe').Path
& $cli --help
& $cli attachments --help
& $cli memory write --help
```

## Thread lifecycle and compaction

The plugin registers asynchronous `SessionStart(startup|compact|fork)`, `SubagentStart`, `PostCompact`, and `PostToolUse` hooks. On Windows x64, these hooks require PowerShell as the Codex environment shell. Each callback runs the bundled Native AOT executable directly with `& "$env:PLUGIN_ROOT/bin/Thread-Memory-Hook.exe"`. It reads a UTF-8 JSON request from stdin and returns `hookSpecificOutput` on stdout when it has additional context. Codex queues that context for delivery when it checks completed hooks. A reminder can arrive after compaction, and recovery guidance can arrive after the first continuation. With manual `/compact`, Codex normally dispatches `SessionStart` on the next regular turn.

For a synchronous command experiment, set `async` to `false` on the selected `SessionStart`, `SubagentStart`, or `PostCompact` handler in an isolated test configuration. Keep `PostToolUse` asynchronous. Main-thread recovery guidance comes from `SessionStart(compact)`. For a child thread, `PostCompact` records the checkpoint and `PostToolUse` delivers recovery guidance. The [synchronous MCP Hook probe](../test-reference/thread-memory/mcp-hook-probe/README.md) uses the same Hook logic over MCP stdio.

After a Desktop plugin update, check the Hook list for enabled and trusted Thread Memory hooks. Codex ties hook trust to plugin content and can request approval again for an updated package.

In main threads, `SessionStart(startup)` asks the agent to maintain its thread note proactively as important decisions, constraints, progress, or next steps change. `SessionStart(compact)` repeats that instruction alongside recovery guidance. If a note is available, read it in full with `memory read`, then search the rollout as needed. If no note is available, search the rollout for missing details. `SessionStart(fork)` prepares the note copy silently.

Startup guidance uses `<thread_memory_maintenance>`. A compaction recovery message starts with `<thread_memory_recovery>` and ends with the same maintenance block used at startup. Each block uses its own opening and closing tags on separate lines.

In spawned subagents, `SubagentStart` gives the same maintenance instruction for the child's own note. `PostCompact` records a pending notice in SQLite for the verified child. The next successful child `PostToolUse` that sees the record claims it and queues one prompt to read the child's full note with `memory read` and search its rollout as needed. The prompt also repeats the maintenance instruction. Parallel calls claim it once, and multiple compactions awaiting a tool coalesce into one prompt. Notifications use the child `agent_id` and verified child transcript header. Internal, attached, and unverified sessions are skipped. Both recovery and usage prompts are claimed before Codex delivers them, so a missing callback or an interruption that discards queued context can leave the prompt undelivered.

Continue from the retained context and current instructions. Local compaction keeps Codex's handoff summary as a user-role item and reassembles the initial context. Other paths, such as remote compaction or a context reset, can leave an encrypted or absent handoff. If details of the active request are missing, use `inspect` to locate a checkpoint and `recover`, `search`, or `transcript` to read only the needed evidence. Confirm the latest user intent, active constraints, and pending work. Check which actions already happened before repeating them. Use the same procedure manually when the hook is unavailable, including from a subagent.

## Thread memory and reminders

`PostToolUse` checks for approaching compaction in both main threads and spawned subagents. For each estimated compaction startup line, including the 65% and 80% compatibility levels, the first reminder is 45,000 tokens early by default to allow time for asynchronous delivery. At 35,000 and 25,000 tokens before a line, the hook follows up only if the active rollout has no complete developer hook message for that reminder. Once the message is found, SQLite records confirmation for that thread, window, and tier. A follow-up says it may be a duplicate. If no note update is needed, ignore it. When one usage sample crosses several points, each tier advances to its latest point and the tool hook emits at most one message. In subagents, a pending recovery prompt takes priority over a usage reminder.

First reminders and follow-ups use `<thread_memory_reminder>` with a `Notify ID: [65:Abc123_-]` footer. The plugin uses its tiers and eight-character window ID to confirm delivery for the original window, even if the reminder arrives after compaction or rollback.

Automatic discovery reads `config.toml` in the Codex home and requires `features.async_compaction` to be enabled. The raw window comes from a matching model catalog entry, including any configured window override and model cap. A configured percentage outside the compatibility levels adds a separate level. If the observed usable window disagrees with the expected model window, the hook skips inferred reminders. It also skips automatic reminders when the home config enables native `token_budget` or when the model window cannot be resolved. Project layers and launch overrides may differ from the home configuration. `THREAD_MEMORY_ASYNC_START_TOKENS` supplies a single authoritative startup line. `THREAD_MEMORY_HANDOFF_LEAD_TOKENS` overrides the first lead. Only checks that fall after that first reminder are used.

Usage comes from the latest usable sample in a bounded rollout tail scan. Copied forks with an authoritative first-owned ordinal can be checked without counting inherited records. For a legacy copied fork without such an ordinal, the hook can verify a compaction or rollback boundary after a settings record for the fork's own thread, and reuse a verified checkpoint on later scans. The hook skips reminders if it cannot verify the window boundary. A large new result, a long reply, or manual compaction can skip the save opportunity.

After verifying a reminder window, the hook can keep a read checkpoint per rollout file in SQLite. It opens the original path and uses the Windows `\\?\` path resolved from the file handle as the checkpoint key when available. It checks the active file's identity and the bytes before the last complete line, then scans from that position. Existing checkpoints for another spelling of the path can be reused after verification. A change in path spelling preserves the active window and its reminder claims. The checkpoint retains a bounded set of usage and turn records for the current window. The hook uses a bounded tail scan when appended records refer to turn details the checkpoint cannot verify, or when the file is replaced, shortened, or otherwise unverifiable. Compaction and rollback start a new window. Startup and reminder scans both accept up to 4 MiB of `session_meta` data before the line ending.

The thread's note persists across compaction and rollback. `memory write` checks that the revision it loaded is still current at save time.

Ask Codex to maintain a thread note, save progress before manual `/compact`, or read the note after compaction. Update relevant sections in place, consolidate duplicates, and remove obsolete details so the note describes the current work. Commands default to `CODEX_THREAD_ID`, the root or subagent's own thread. `memory write` creates or replaces the entire note with UTF-8 text from stdin. Notes over 32 KiB (32,768 UTF-8 bytes) are shortened at a complete UTF-8 character to make room for the `[Summary truncated]` marker. The receipt reports truncation.

`memory read` writes the stored UTF-8 Markdown to stdout without adding a line ending. For a known thread without a saved note, stdout is empty and the command succeeds. A successful write reports the full saved note's UTF-8 byte count, for example `Note saved. Total size: 16,000 UTF-8 bytes.` The count includes any truncation marker. If the saved size exceeds 20 KiB, the receipt reminds the agent to exceed that size only for essential details and to stay within its 26 KiB writing limit. Memory failures print `Failed [code]: message` on stderr and exit nonzero. Rollout queries report failures as JSON on stderr. See the [Skill's PowerShell examples](../plugins/thread-memory/skills/thread-memory/SKILL.md#maintain-the-markdown-note) or run `memory --help` for command help.

For an inspection that only needs part of the note, capture the Markdown in PowerShell and emit the requested section or size summary. See [partial reads and size checks](../plugins/thread-memory/skills/thread-memory/references/notes.md#read-part-of-a-thread-note).

Main-thread forks use the creation timestamp in the new thread's original verified rollout header to choose the parent's version. The first `SessionStart(fork)` or first memory access copies that version, including an empty result if the parent had no note at that time. Further reads and edits use the new thread's revisions, and a later main-thread fork can inherit them. If a verified fork's inheritance is unavailable, an explicit `memory write` can start its own note. The receipt reports the inheritance failure. The note store and fork logic use local SQLite and rollout headers.

The native Hook, CLI, and panel share `$CODEX_HOME/state/plugins/thread-memory/handoff.sqlite3`. Thread Memory opens it on the first state write, including a Hook diagnostic or a note edit. `PRAGMA user_version` identifies the schema. Version 1 commits its tables and schema version in one transaction. Existing window notes are included in the durable note during initialization, including the snapshots needed for fork inheritance. The optional `memory_reads` table is created on the first recorded self-read and follows the panel's deleted-thread cleanup.

### Hook diagnostics

Use `diagnostics --limit 20` with the same CLI to read the most recent events for `CODEX_THREAD_ID`. Pass `--thread UUID` for another thread, including a spawned subagent. The JSON result provides `thread_id` and `items` in newest-first order. Events contain a UTC `timestamp` and `event`, with a `window` key and limited decision details when available. Use `jq -c '.items[]'` to select entries.

Context preparation, a subagent's queued recovery, and reminder transitions leave diagnostic entries. `fork_note_checked` records the result of the silent note check on fork. The following events expose reminder and compaction evidence in `.details`.

- `reminder_context_prepared` records generated context. `reminder_receipt_observed` records confirmation at a reminder check. Both include token `used`, observed `capacity`, and `stages` as tier and stage pairs. Stages 0 through 3 represent first reminder, first check, final check, and confirmed receipt. `leads` gives the effective `[first, check, final]` token offsets with `0` for disabled checks. `estimated_startups` contains `[tier, tokens]` pairs, and `notify_id` is the short window ID from the reminder footer.
- `reminder_rollout_observed` records each distinct Hook message seen in the rollout for a tier, including `notify_id`, `tier`, and `recorded_at`. It adds `leads` and the event's `window` when it can match the reminder policy. `duplicate` marks an additional observed message for the same thread, notification window, and tier. A prepared follow-up may be the only message recorded by Codex. The rollout timestamp shows when Codex recorded the message. Whether the model read it remains unknown, as does delivery when the scan finds no evidence.
- `compaction_checkpoint_observed` reports `compacted_at`, `previous_window`, and `note_updated_at` for the note version effective at compaction. These fields are `null` when the corresponding information is unavailable.

Use `diagnostics --summary` without `--thread` or `--limit` to read counts across threads. The response contains only `.items`, with `leads`, `tier`, `metric`, `remaining_tokens_bucket`, and `count` on each row. A Hook message covering several tiers contributes separately to each tier.

- `first`, `followup_1`, `followup_2`, and `receipt_confirmed` count Hook stage decisions. The remaining-token bucket is the estimated startup threshold minus the observed usage, rounded down to a multiple of 5,000. For example, -1 falls in the -5,000 bucket.
- `delivery_observed` counts distinct recorded messages with a known reminder policy, and `duplicate_observed` counts their additional occurrences for the same notification window and tier. Their bucket is `null`. All attempts for one window and tier share a notification ID, so a recorded duplicate has no specific retry stage. If settings change mid-window, the first recorded policy for that window and tier determines which group receives these observations.

The SQLite schema remains at version 1 and adds optional tables for observations and grouped counts. Diagnostic entries store only event metadata and are capped at 2,048 recent entries across all threads. Recording is best effort. Recovery hooks use a 4 MiB budget per scan, with a bounded retry if a cached checkpoint lacks evidence. Later tool callbacks can pick up additional evidence. Cleanup removes a deleted thread's diagnostics and observation records. The grouped counts retain no thread identifiers and survive cleanup. An unavailable rollout also limits what later scans can record.

### Desktop panel

Open **Thread Memory** from Codex Desktop's sidebar to browse main threads with a saved note or with subagents that saved notes. Ordinary user forks have their own entries. Choose **All**, **Unarchived**, or **Archived** and search by title or UUID. **Latest note update** orders main threads by the newest saved note in each group. **Latest thread update** uses the main thread's timestamp from the Codex index and falls back to the note timestamp. Counts reflect the current filters. Threads with only legacy handoffs show the latest saved handoff.

Selecting a main thread opens its note directory and selects **/root**, the main thread's own note. **/root** stays at the top across searches and pages and shows an empty state when it has no saved note. Subagent notes appear below it, newest note update first. Long titles use an ellipsis in the note directory. On wide panels, the main-thread list, note directory, and reader appear side by side. Narrow panels put the note directory above the reader and offer **Back to main threads**.

The note directory uses Codex's indexed spawn relationships to find descendants with saved notes and loads the note body when selected. It shows canonical agent paths such as `/root/principal_language` and uses a short thread ID when the path is unavailable. Search subagents by agent path or thread UUID. The local MCP panel uses Markdig to render Markdown, including headings, nested lists, blockquotes, and read-only task checkboxes. Notes use absolute paths in links to local files. The reader displays link destinations, image references, and embedded HTML as text. **Copy note** copies the original Markdown. **Thread ID** opens a popover without moving the note.

Forked main threads show their own subagent notes by default. Enable **Include inherited subagent notes** to also browse saved notes from a verified source thread's spawn tree as of the relevant fork. Inherited notes are labeled in the directory and reader. When a source rollout is temporarily unreadable, the panel keeps the selection and reports which scope it could verify. Refresh to retry. The main directory still uses saved notes from each thread's own group.

The local stdio server's `handoff_manager` tool opens `ui://thread-memory/notes` as a global MCP Apps entrypoint. The plugin list uses `assets/thread-memory-icon.png`. The sidebar uses `skills/thread-memory/assets/thread-memory-entrypoint.png`. [Server implementation](../plugins/thread-memory/panel/Program.cs) · [Shared Codex MCP Apps guide](codex-mcp-apps.md)

The panel follows the Codex Desktop theme, including live theme and accent changes. It uses the browser's color scheme when the host omits its theme. The packaged panel HTML includes the version beside the title on first load.

The note reader shows relative times for the last update and the selected thread's last read of its own saved note. Hover over either label for its full UTC timestamp. A successful CLI `memory read` counts when it returns saved text and its target matches `CODEX_THREAD_ID`. Cross-thread reads, edits, and panel previews leave the read timestamp unchanged. The timestamp survives compaction and belongs to the thread that read the note. Forked threads start with no read timestamp and historical subagent snapshots hide the label.

The reader shows the size of the saved Markdown beside the timestamps. Hover over the size for the exact UTF-8 byte count.

The panel loads the directory when it starts. Choose **Refresh** to reload the current view while keeping the selection, search, filters, sort order, and reading position. The panel keeps a selection that moves to another page and checks its archive status before applying the current filter. If the selected subagent note is gone, the reader returns to **/root**. If the selected main thread no longer has a note group, the panel clears the selection. If the current page disappears, the directory goes to the last available page. When note storage is temporarily unavailable, the panel keeps the loaded directories, pages, and note and displays a retry message. An unavailable or rebuilding subagent index leaves previously loaded subagent rows visible. Use **Retry connection** or reopen the panel if the initial connection fails.

Cleanup covers notes and search index entries for deleted main threads and their deleted subagents, including threads that only have search entries. It requires a completed local Codex index and checks thread rows, spawn and attachment relationships, the session name index, and active and archived rollout names. Surviving evidence protects stored data for those threads. On confirmation it rechecks the selected IDs and initializes any surviving ordinary fork that still depends on the source note. When an uninitialized fork cannot be verified, the cleanup result identifies sources kept for protection. Codex deletes the spawn subtree together. It blocks deletion while a surviving attached thread or external rollout reference depends on the source. The local index has no retained deletion log, so cleanup infers deletion from the verified absence of all local records.

Closing **Manage data** dismisses a pending cleanup preview. The preview and confirmed deletion show progress after 25 seconds and continue waiting for their MCP results. A confirmed deletion can continue after the panel closes the confirmation. The result reports candidates that still exist separately from threads protected by a fork dependency. If the deletion result is unknown, the panel refreshes the directory so you can recheck the stored data before retrying.

## Progressive reads

Start with locations and counts. Search within a likely window, time range, or turn, then read only the records needed. The examples below reuse `$cli` from [CLI help](#cli-help).

```powershell
$thread = '<thread-uuid>'
$since = '2026-11-20T14:00:00+08:00'
$until = '2026-11-20T14:30:00+08:00'

& $cli inspect --thread $thread | jq '{segments, checkpoint_count}'
& $cli windows --thread $thread --since $since --until $until | jq '.items[] | {window, first_at, last_at, compacted_at}'
& $cli search --thread $thread --window 2 --ignore-case --limit 5 'imagegen' | jq '.items[] | {ref, line, text}'
```

Pass a hit's `ref` to `read --ref` with the same source, or use the [pipeline below](#powershell-and-jq-pipelines) to pass it directly from `jq`.

Rollout queries in JSON mode emit one compact UTF-8 JSON object on stdout and send errors to stderr. Use `jq` to project only the fields you need. Paged results put records in `.items[]` and return `.next_cursor`, which is `null` on the final page. Continue with `--cursor` set to `.next_cursor`. Keep the same rollout source and repeat the query filters for ordinary pagination. Tool detail cursors carry the ID and paging options. The per-item and per-page character limits apply to excerpts. JSON metadata and escaping add to the size of stdout.

Pass cursor strings through unchanged. Start a fresh query to get refs, IDs, and cursors in the native format if you previously used the Python CLI.

For rollout queries, `--output NEW_PATH` writes the result to a new file and returns a JSON receipt with `output` and `bytes`. Paged results also include `next_cursor` in the receipt, including `null` on the final page. File output uses the same page limits. Request each needed page with its own output path. For a readable chat excerpt, explicitly select `transcript --format markdown` with the relevant filters and add `--output NEW_PATH` to save it.

With no explicit rollout source, the CLI uses `CODEX_THREAD_ID`, which identifies the subagent in a subagent shell. To inspect the root from that shell, pass `--thread $env:CODEX_SESSION_ID` in PowerShell. The CLI follows recorded `history_base` links. Use `--previous` to locate ancestors referenced by those links when they are outside the selected Codex home.

## PowerShell and jq pipelines

Use PowerShell 7.4 or later for the pipelines below. Reuse an argument array to keep the rollout source consistent between requests. `read --ref -`, `images --ref -`, and `attachments --ref -` read exactly one raw UTF-8 reference from stdin. `tool-input --id -` and `tool-output --id -` read one ID. `export-image --id -` and `export-audio --id -` read one or more IDs. Paged commands read one cursor with `--cursor -`. Use one raw UTF-8 line per value and one stdin consumer per invocation. The EXE has no runtime dependency on `jq`.

```powershell
$PSNativeCommandUseErrorActionPreference = $true
$ErrorActionPreference = 'Stop'
$source = @('--thread', $thread)

& $cli search @source --window 2 --limit 1 'imagegen' |
    jq -er '.items[0].ref' |
    & $cli read @source --ref - |
    jq '.items[0] | {line, fields}'

$toolPage = & $cli read @source --tool apply_patch --type custom_tool_call_output --limit 1 |
    jq -er 'first(.items[].output_id // empty)' |
    & $cli tool-output @source --id - --lines 8
$toolPage | jq -r '.items[].text'
if ($toolPage | jq -r '.next_cursor // empty') {
    $toolPage | jq -er '.next_cursor' |
        & $cli tool-output @source --cursor - |
        jq -r '.items[].text'
}

& $cli transcript @source --role user --since $since --until $until --limit 5 |
    jq -er 'first(.items[] | select(.image_count > 0) | .ref)' |
    & $cli images @source --ref - |
    jq -er '.items[].image_id' |
    & $cli export-image @source --id - --max-resolution 512 |
    jq '{unknown_ids, images: [.images[] | {image_id, thumbnail_file, thumbnail_width, thumbnail_height, export_error}]}'

$chat = @('--origin', 'current', '--window', 'current', '--role', 'assistant', '--limit', '1')
$page = & $cli transcript @source @chat
$cursor = $page | jq -r '.next_cursor // empty'
if ($cursor) {
    $page | jq -er '.next_cursor' |
        & $cli transcript @source @chat --cursor - |
        jq -r '.items[].text'
}
```

`jq -er` writes unquoted values and exits nonzero when a required projection is empty or `null`. PowerShell's native command error handling stops on failed commands. An empty match page or a record without attachments is a successful query, so use `jq -r` when zero results are expected. `.next_cursor // empty` gives the `if` test an empty value on the final page.

## Errors and exit codes

Rollout and diagnostics errors write one compact UTF-8 JSON line to stderr with an `error` object. The object has `code` and `message`, and may include `hint`, `path`, or `line`. Memory command errors write plain text to stderr. Messages are capped at 400 characters plus an ellipsis. Malformed JSONL can report the file path and physical line with a hint to retry using `--salvage`. `--help` prints plain-text help.

| Exit code | Meaning |
| --- | --- |
| `0` | Success, including an empty result. A batch image export can report individual failures in its result. |
| `2` | `invalid_arguments`, such as a malformed option value. |
| `1` | `invalid_input`, `invalid_rollout`, `not_found`, `permission_denied`, `output_exists`, `io_error`, or `runtime_error`. |
| `130` | `interrupted` on Ctrl+C. |
| `141` | The downstream pipe closed. This exit is quiet. |

When handling failures in PowerShell, capture stderr separately and save `$LASTEXITCODE` immediately after running the CLI. `jq` reports its own status, so use the CLI status to decide which stream to parse. This example uses an explicit exit guard in a scope with native command exception handling disabled.

```powershell
& {
    $PSNativeCommandUseErrorActionPreference = $false
    $stderr = New-TemporaryFile
    try {
        $result = & $cli read --thread $thread --limit 1 2> $stderr.FullName
        $status = $LASTEXITCODE
        if ($status -eq 0) {
            $result | jq '.items[]'
        } elseif ($status -ne 141) {
            jq -c '.error | {code, message, hint, path, line}' $stderr.FullName
        }
    } finally {
        [IO.File]::Delete($stderr.FullName)
    }
}
```

## Thread lineage

`lineage` reports `root_session_id`, physical rollout segments in `segments`, and fork ancestry in `fork_chain`. The fork chain follows `forked_from_id`. `spawned_by` identifies the thread that launched the subagent. A subagent can have a spawn parent without a fork parent. Check `fork_chain_end` for `root`, `missing`, `cycle`, or `unreadable`.

For a thread marked `paginated` in the active Codex index, `--thread` reports an unreadable or missing current rollout. Use `--rollout PATH` to inspect a specific historical segment explicitly.

| `segments[].relation` | Meaning |
| --- | --- |
| `current_rollout` | The selected thread's latest rollout segment, or the explicit `--rollout` input. |
| `same_thread_history` | An older segment owned by the selected thread, such as history retained across a revert. |
| `inherited_thread_history` | A physically linked segment owned by another thread. |

`windows`, `search`, `read`, `transcript`, `images`, and `tokens` accept `--origin all`, `--origin current`, `--origin inherited`, or `--origin unknown`. The default is `all`. `current` includes the selected thread's own records in older segments. `inherited` includes parent segments reached through `history_base` and copied records in a child rollout whose ordinals precede `subagent_history_start_ordinal`. Legacy copied rollouts without an ordinal use a sequential scan to find a settings record for the fork's own thread. Before that record, explicit copies are `inherited` and ambiguous records are `unknown`.

For copied records, `forked_from_thread_id` reports the recorded fork parent. `timestamp_origin: copied_at` means the timestamp describes when the child recorded the copy. Use the parent rollout to query the original message time. `windows` filters a closed window by the origin of its checkpoint, and its start can fall in a different segment. Use `tokens --window N --origin current` to count only the selected thread's usage inside that window.

## Compaction windows and chat

`inspect` reports discovered segments, `checkpoint_count`, and at most the five most recent checkpoints. Use `windows` to page through the full list. Each item reports source locations for `read`, `first_at` and `last_at` for the earliest and latest usable timestamps in the window, and `compacted_at` for the checkpoint timestamp. Add `--window current` to inspect the open window after the latest checkpoint. Its `compacted_at` is `null`. Time bounds select windows that overlap the requested interval and skip windows without usable timestamps.

`jq` projects missing keys as `null`. Use `has()` when the keys must exist but may legitimately be null. Use `jq -e` with a predicate that checks what the caller requires. This example requires one window item with all three time keys and a known checkpoint time.

```powershell
& $cli windows --thread $thread --window 2 |
    jq -e '.items | length == 1 and (.[0] | has("first_at") and has("last_at") and has("compacted_at") and (.compacted_at | type == "string"))'
```

`transcript` returns user and assistant messages with their recorded timestamps and source locations, including stored realtime voice transcripts and user-facing assistant messages recorded as explicit async delivery events. Use `--role user` or `--role assistant` to focus on one speaker. Use `search` or `read` for system and developer instructions, tool metadata, compaction records, or other legacy message events.

Use `transcript --last N` for the newest messages in the selected scope, returned in chronological order. It uses the normal text budgets. For forward pagination, omit `--last` and use `--cursor`. Use `--phase final`, `--phase commentary`, or `--phase partial` to select assistant messages with that recorded phase. Messages without a recorded phase are excluded by this filter.

```powershell
& $cli transcript --thread $thread --origin current --last 6 --phase final --max-chars 240 |
    jq '.items[] | {phase, text, ref}'
```

## Recorded instructions

`read` and `search` expose message records with explicit `system` or `developer` roles. They also expose two stored instruction fields through the same role filters.

| Role | `item_type` | Recorded source |
| --- | --- | --- |
| `system` | `base_instructions` | `session_meta.base_instructions.text`, a stored Responses API instructions snapshot. |
| `developer` | `developer_instructions` | `turn_context.collaboration_mode.settings.developer_instructions`, including the legacy form directly under `collaboration_mode`. This is a mode setting that can repeat between turns. |

Use `kind` and `item_type` to distinguish explicit message records from settings and snapshots. Rollouts can omit these fields, especially in older formats, and can lack server-side instructions. The commands only expose evidence available in the selected rollout.

```powershell
& $cli read --thread $thread --role system --limit 3 --max-chars 240 |
    jq '.items[] | {kind, item_type, role, line, fields}'
& $cli search --thread $thread --role developer --limit 5 --max-chars 240 'workspace' |
    jq '.items[] | {kind, item_type, role, line, ref, text}'
```

Use `instructions --window N` for system and developer messages in a compaction checkpoint's recorded `replacement_history`. Use `windows` to find the checkpoint number. Repeat `--role` to select both roles explicitly. `checkpoint_item` is the zero-based index in the full snapshot. Pass that index to `--item` and use `--chars START:END` for a zero-based, half-open slice. Use `--limit`, `--max-chars`, and `--budget-chars` to bound excerpts and `--cursor` to continue with the same checkpoint and filters.

```powershell
& $cli instructions --thread $thread --window 2 --role developer --limit 5 |
    jq '{items: [.items[] | {role, checkpoint_item, text_total_chars}], next_cursor}'
& $cli instructions --thread $thread --window 2 --item 3 --chars 0:240 |
    jq -r '.items[].text'
```

## Token usage

`tokens` reports all recorded token categories for a window, time range, or other record scope. Choose `--by-response` for individual response usage or `--by-summary` for encrypted compaction summary counts. `windows` returns window metadata by default. Add `--with-tokens` to include the usage aggregate in `.items[].token_usage` for each full window.

| `totals` field | Recorded count |
| --- | --- |
| `input_tokens` | Input tokens. |
| `cached_input_tokens` | Cached input tokens. |
| `cache_write_input_tokens` | Cache-write input tokens. |
| `output_tokens` | Output tokens. |
| `reasoning_output_tokens` | Response-level reasoning output, including encrypted reasoning. |
| `total_tokens` | Total tokens reported by the response. |
| `encrypted_summary_output_tokens` | Output tokens from responses matched to encrypted compaction summaries. |

`response_count` counts distinct captured responses in scope. `responses_with_usage` reports the number of responses with a recorded count for each category. `encrypted_summary_count` counts captured encrypted summaries in scope. A category with no known count has a `null` total. The categories can overlap, so use the recorded `total_tokens` for the overall usage.

Reasoning counts apply to entire responses. With `--by-summary`, `.items[]` lists encrypted summaries with the compaction response's `usage.output_tokens` when its ID matches `compaction_response_id`. A missing match or count yields `null`. Each item's `window` is the recorded checkpoint number, or `null` for a legacy checkpoint without a recorded number or a standalone summary. A checkpoint can provide matched usage from its snapshot even when the response falls outside the selected records. The encrypted-summary subtotal is reported separately because the same response may already contribute to output and total usage. Search and read omit encrypted payloads and mirrored reasoning text.

## Search and ranges

When the rollout's contents are unfamiliar, use `inventory` to count records by kind, item type, event type, extension, and role in a chosen scope. Each group has a `count` and one representative `example.ref`, with no text excerpt. Apply the usual history filters, `--type`, or `--role` to narrow the inventory. `read --metadata-only` gives individual record metadata and `body_available` with an empty `fields` array. If a record has available text, use its `ref` with `read --ref REF`. Use tool detail commands for tool bodies. The readable projections include selected fields from verified answers, outcomes, goals, settings, and agent records.

```powershell
& $cli inventory --thread $thread --window 2 --limit 8 |
    jq '{items: [.items[] | {kind, item_type, count, example}], next_cursor}'
& $cli read --thread $thread --window 2 --metadata-only --limit 8 |
    jq '.items[] | {kind, item_type, line, body_available, ref, input_id, output_id}'
```

For a single uncompressed Codex rollout in the selected home's `sessions` or `archived_sessions` directory, a time- or window-scoped `search` can build a metadata cache in `$CODEX_HOME/state/plugins/thread-memory/rollout-index.sqlite3`. The rollout header must match the owner in the filename. The cache stores timestamps, physical offsets, compaction checkpoints, and the context needed to annotate each record. Scoped queries extend the cache with complete appended rows, select candidate offsets in SQLite, and seek into the original JSONL for text matching. A change in file identity or the checked bytes triggers a rebuild. Line ranges, cursor continuations, `read --ref`, and `transcript --last` can reuse a verified index. The streaming reader handles multi-segment lineages, compressed files, named tool matching, `--salvage`, and files outside the selected Codex home's session directories. The first indexed search can take longer while it builds the cache.

Each hit reports `ref`, `field`, `field_index`, `match_start`, `match_end`, `text_offset`, and `text_total_chars`. Use `read --ref REF` to reopen the matching field. For a large field, use `--chars START:END` to read a slice. You can also select one physical line and use zero-based `--field-index N` or `--field NAME`. When a field selector returns exactly one field, the ref reopens that field. Character offsets are zero-based, include `START`, and exclude `END`. Use adjacent ranges to read additional slices within the page budget.

For record queries, a numbered window covers records after the previous checkpoint through the selected checkpoint. Window zero represents an inherited initial checkpoint when the rollout records one. The open window covers the physical records after the latest checkpoint. Time-scoped results preserve the original record timestamps.

Use the source segment and line number from the result to cite or revisit a record. A direct `read --segment NAME_OR_ID --lines N:N` can report a record that has metadata but no readable fields. Search operates on extracted text and image references, so image data URLs stay out of the excerpts. Search and read inspect physical records, including turns later rolled back. Window listings mark inferred window numbers for older checkpoints that did not write one.

## Record references

`search`, `read`, and JSON `transcript` put an opaque `ref` on each item. `inventory` puts one in each group's `example`. Pass a ref to `read --ref REF` with the same rollout source to reopen a record, a selected field, or a transcript message. `read --ref` returns text in `.items[].fields[].text` for all these sources. A ref checks the raw JSONL record bytes excluding the final line terminator and the working directory used to resolve attachments. Changes to the record or its working directory can make a ref stale. Use `images --ref REF` or `attachments --ref REF` to list media on that exact record. For a transcript ref, the lookup follows the transcript message's visible attachment projection. A related tool call or attachment on another record requires its own ref or a scoped catalog query.

Use `--ref -` to pipe one ref from `jq -er`. Record scope selectors such as `--window`, `--turn`, `--since`, `--until`, `--segment`, and `--lines` are replaced by the ref. Get a fresh ref if the underlying record is rewritten or no longer resolves under the selected source.

## Tool arguments and returns by ID

User messages and assistant replies remain directly available through `search`, `read`, and `transcript`. For tool records, `search`, its surrounding records, and `read` expose metadata such as the tool name and `call_id` when available, source location, and `input_id` or `output_id`. Search matches tool metadata only. Argument values and return bodies require their respective IDs, including when using `read --field` or `read --field-index`.

`search --tool NAME` and `read --tool NAME` prefer the name recorded on the tool record. For an unnamed return, the filter can use a unique compatible earlier call in the same segment and history boundary, including a call outside the selected line range. Ambiguous or incompatible calls leave the tool name unknown. Read the resolved label with `read --tool NAME | jq -r '.items[].tool_name'`. Search patterns and field selectors operate on recorded fields.

Pass `input_id` to `tool-input --id ID` or `output_id` to `tool-output --id ID` with the same rollout source. With those commands, `--lines 10:20` jumps directly to lines of the payload across fields. With `read`, the same range selects physical JSONL records.

The character budget applies to both line counts and explicit ranges. A line that cannot fit on an empty page is split across pages. The cursor restores the ID, line selection, and character budget on the same command and source. A tool cursor checks the raw JSONL record bytes excluding the final line terminator. Appending later records preserves the cursor, while editing or reformatting the selected record can invalidate it. Start a fresh page to replace a stale tool detail cursor. For large payloads, write pages to separate files with `--output NEW_PATH` and search or read those files selectively. Use the image commands for media stored as image blocks.

For structured payloads, pass `--pointer JSON_POINTER` with the same `--id` to `tool-input` or `tool-output`. This reads a typed JSON `.value` from the supported fields. The empty pointer `--pointer ''` selects the available root. Use `~0` for `~` and `~1` for `/` in a key. Embedded media, encrypted content, and internal fields are excluded. If the JSON value exceeds `--budget-chars`, select a narrower pointer or increase the budget.

```powershell
& $cli tool-input --thread $thread --id '<input-id>' --pointer '/arguments/nested' --budget-chars 800 |
    jq '.value'
```

## Attachment lookup and export

`images` lists image IDs, timestamps, and source locations without decoding or exporting the media. IDs locate an occurrence using the rollout position and a fingerprint of the image data or reference. The same image can appear under multiple IDs. Run `images` again to get fresh IDs after migrating or rewriting a rollout. Use `images --ref REF` to resolve attachments from a selected record.

Use `attachments` to catalog images and audio. It provides an `attachment_id`, availability, recorded local paths when present, and an `image_id` for images. The catalog includes recorded image-generation input paths and embedded image or audio MCP resources. For legacy user messages, a complete `image_order` determines the order of inline images and file references. The catalog excludes inline media bytes and makes no network requests.

```powershell
& $cli attachments --thread $thread --window 2 --media audio --role user --limit 5 |
    jq '.items[] | {attachment_id, media, availability, path, resolved_path}'
```

Pass an ID from `images` to `export-image --id ID` with the same rollout source. For inline Base64, export saves the decoded original and a thumbnail. For a readable local path, export saves a thumbnail and reports the existing original path.

Thumbnail scaling preserves aspect ratio. By default, images under the resolution cap keep their original dimensions. The CLI uses Lanczos resampling for WebP thumbnails. Successful thumbnails report `thumbnail_file`, `thumbnail_width`, and `thumbnail_height`. For a single required thumbnail, use `jq -er '.images[0].thumbnail_file'`. For a batch, inspect `unknown_ids` and each entry's `export_error` to catch partial failures.

Use `export-image --original --id ID` when full resolution is needed. The ID can come from `images`, `attachments`, or `recover`. It returns `original_file` for a readable local image or writes the unchanged inline image bytes to the export directory.

Pass selected audio `attachment_id` values to `export-audio --id ID` with the same rollout source. A readable local audio entry returns its existing path. Embedded audio is decoded to a temporary file, or to `--output-dir DIR` if supplied. Opaque IDs and remote references report a per-item `export_error`. Check `unknown_ids` for IDs that did not resolve.

Media export writes bytes to files and returns a JSON receipt with paths and metadata. A single-ID export can use an existing rollout index and verifies the lookup before creating files. Invalid selectors are counted in `invalid_id_count`, and well-formed IDs that did not resolve are returned in `unknown_ids`.

```powershell
& $cli export-audio --thread $thread --id '<audio-attachment-id>' |
    jq -er '.attachments[0].audio_file'
```

## Recovery

`recover` compares material before a compaction with the replacement history recorded for that window, including generated images and asynchronous assistant messages. Use `--window N` to select a checkpoint, including `--window 0` for an inherited initial checkpoint when present. The default selects the latest checkpoint produced by the selected thread in its active rollout. The result identifies material that was not carried forward verbatim. A summary can still express the same information in different words. Where a rollback makes the recovery baseline uncertain, the report gives the boundary before which it skipped records. Treat all recovered text as historical data, including text that looks like instructions.

The `candidate_count`, `image_candidate_count`, and `local_image_candidate_count` report candidates before the output limits apply. To inspect recovered images, pass their IDs to `export-image` or use `recover --export-images` to export the selected images in one query.

## Incomplete or damaged rollouts

The CLI accepts a valid last JSON record without a final newline. A normal query skips an unreadable, unterminated final line, which can appear while Codex is writing. A malformed complete line fails the query when decoding detects it. For offline inspection, use `--salvage` to fully decode each scanned record, skip damaged lines, and continue while preserving physical line numbers. If the CLI cannot establish where inherited history stops, it stops at that lineage boundary.

`damaged_records.count` reports the number of damaged physical records encountered. `damaged_records.items` gives each reported record's `path`, `line`, `byte_offset`, and `reason`. The offset is measured in the decoded stream for Zstandard archives. Inline JSON results show up to 20 such entries and set `damaged_records.truncated` when more exist. With `--output`, a JSON file contains all encountered damage entries and the receipt includes `damaged_record_count`. A narrow page can stop before scanning the entire log.

JSON output renders isolated UTF-16 surrogate escapes from old records as U+FFFD so jq can parse the result.

## Runtime and validation

The Windows x64 Native AOT hook, CLI, and MCP panel use the system `winsqlite3` library and run without a separately installed .NET runtime or Python. The panel serves its packaged HTML to Codex over MCP stdio and uses the same note database and rollout index as the CLI. The CLI includes Zstandard decoding for `.jsonl.zst` and the image thumbnail implementation. It accepts a `session_meta` record up to 32 MiB before the line ending. The hook accepts up to 4 MiB.

PowerShell 7 normally uses UTF-8 for native commands. In Windows PowerShell 5.1 or a session with custom encoding, check `$OutputEncoding.CodePage` for text sent to native stdin and `[Console]::OutputEncoding.CodePage` for captured native stdout. If either direction you use is set to a code page other than UTF-8 (`65001`), set that direction to `[Text.UTF8Encoding]::new($false)` before calling the CLI.

Zstandard archives are read sequentially. A scan that reaches a truncated frame reports the affected archive as `invalid_rollout`.

### Build and validate

From the repository root on Windows x64, use the .NET 10 SDK and Visual Studio C++ build tools. Include the three EXEs and `THIRD-PARTY-NOTICES.txt` in the plugin package.

When preparing a release, update the title badge in `plugins/thread-memory/skills/thread-memory/assets/handoffs.html` to match the version in `plugins/thread-memory/.codex-plugin/plugin.json`. The MCP panel check verifies that the first resource read serves that badge with the packaged HTML.

```powershell
$plugin = 'plugins/thread-memory'
$artifacts = Join-Path (Resolve-Path .) 'tmp/thread-memory-native'
$targets = @{
    'Thread-Memory-Hook' = 'src/thread-memory-hook.csproj'
    'Thread-Memory' = 'cli/thread-memory-cli.csproj'
    'Thread-Memory-Panel' = 'panel/thread-memory-panel.csproj'
}
foreach ($target in $targets.GetEnumerator()) {
    $publish = Join-Path $artifacts $target.Key
    dotnet publish "$plugin/$($target.Value)" -c Release -r win-x64 --artifacts-path $artifacts -o $publish
    $publishExit = $LASTEXITCODE
    if ($publishExit -ne 0) { throw "Native AOT publish failed for $($target.Key) ($publishExit)" }
    Copy-Item -LiteralPath (Join-Path $publish "$($target.Key).exe") -Destination "$plugin/bin/"
}
```

Run the file-based C# integration checks after packaging the executables. Each check creates an isolated Codex home. It can also take explicit executable paths after `--`.

```text
dotnet run --file plugins/thread-memory/tests/verify-rollout.cs
dotnet run --file plugins/thread-memory/tests/verify-media.cs
dotnet run --file plugins/thread-memory/tests/verify-memory.cs
dotnet run --file plugins/thread-memory/tests/verify-hook.cs
dotnet run --file plugins/thread-memory/tests/verify-panel.cs
dotnet run --file plugins/thread-memory/tests/verify-panel-ui.cs
python <skill-creator>/scripts/quick_validate.py plugins/thread-memory/skills/thread-memory
python <plugin-creator>/scripts/validate_plugin.py plugins/thread-memory
```

The panel UI check uses an installed Chrome or Edge with a temporary browser profile and a simulated Codex host.
