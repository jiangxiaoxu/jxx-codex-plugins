# Thread Memory

Use `$thread-memory` to maintain versioned notes across context compaction in main threads and subagents. Main-thread forks get an independent copy of the note as of their creation time. Subagents start with an empty note, including when they inherit chat history. The Python CLI also locates compaction windows, searches local rollout history, and retrieves selected tool details and attachments by ID. It opens Codex state and rollout files read-only. Thread note revisions, legacy window handoffs, and reminder claims live in plugin SQLite storage.

## Thread lifecycle and compaction

The plugin registers asynchronous `SessionStart(startup|compact|fork)`, `SubagentStart`, `PostCompact`, and `PostToolUse` hooks. On Windows x64, these hooks require PowerShell as the Codex environment shell. Each callback runs the bundled Native AOT executable directly with `& "$env:PLUGIN_ROOT/bin/Thread Memory Hook.exe"`. It reads a UTF-8 JSON request from stdin and returns `hookSpecificOutput` on stdout when it has additional context. Codex queues that context for delivery when it checks completed hooks. A reminder can arrive after compaction, and recovery guidance can arrive after the first continuation. With manual `/compact`, Codex normally dispatches `SessionStart` on the next regular turn.

After a Desktop plugin update, check the Hook list for enabled and trusted Thread Memory hooks. Codex ties hook trust to plugin content and can request approval again for an updated package.

In main threads, `SessionStart(startup)` asks the agent to maintain its thread note proactively as important decisions, constraints, progress, or next steps change. `SessionStart(compact)` repeats that instruction alongside recovery guidance. If a note is available, read it in full with `memory read`, then search the rollout as needed. If no note is available, search the rollout for missing details. `SessionStart(fork)` prepares the note copy silently.

Startup guidance uses `<thread_memory_maintenance>`. A compaction recovery message starts with `<thread_memory_recovery>` and ends with the same maintenance block used at startup. Each block uses its own opening and closing tags on separate lines.

In spawned subagents, `SubagentStart` gives the same maintenance instruction for the child's own note. `PostCompact` records a pending notice in SQLite for the verified child. The next successful child `PostToolUse` that sees the record claims it and queues one prompt to read the child's full note with `memory read` and search its rollout as needed. The prompt also repeats the maintenance instruction. Parallel calls claim it once, and multiple compactions awaiting a tool coalesce into one prompt. Notifications use the child `agent_id` and verified child transcript header. Internal, attached, and unverified sessions are skipped. Both recovery and usage prompts are claimed before Codex delivers them, so a missing callback or an interruption that discards queued context can leave the prompt undelivered.

Continue from the retained context and current instructions. Local compaction keeps Codex's handoff summary as a user-role item and reassembles the initial context. Other paths, such as remote compaction or a context reset, can leave an encrypted or absent handoff. If details of the active request are missing, use `inspect` to locate a checkpoint and `recover`, `search`, or `transcript` to read only the needed evidence. Confirm the latest user intent, active constraints, and pending work. Check which actions already happened before repeating them. Use the same procedure manually when the hook is unavailable, including from a subagent.

## Thread memory and reminders

`PostToolUse` checks for approaching compaction in both main threads and spawned subagents. For each estimated compaction startup line, including the 65% and 80% compatibility levels, the first reminder is 45,000 tokens early by default to allow time for asynchronous delivery. At 35,000 and 25,000 tokens before a line, the hook follows up only if the active rollout has no complete developer hook message for that reminder. Once the message is found, SQLite records confirmation for that thread, window, and tier. A follow-up says it may be a duplicate. If no note update is needed, ignore it. When one usage sample crosses several points, each tier advances to its latest point and the tool hook emits at most one message. In subagents, a pending recovery prompt takes priority over a usage reminder.

First reminders and follow-ups use `<thread_memory_reminder>` with a `Notify ID: [65:Abc123_-]` footer. The plugin uses its tiers and eight-character window ID to confirm delivery for the original window, even if the reminder arrives after compaction or rollback.

Automatic discovery reads `config.toml` in the Codex home and requires `features.async_compaction` to be enabled. The raw window comes from a matching model catalog entry, including any configured window override and model cap. A configured percentage outside the compatibility levels adds a separate level. If the observed usable window disagrees with the expected model window, the hook skips inferred reminders. It also skips automatic reminders when the home config enables native `token_budget` or when the model window cannot be resolved. Project layers and launch overrides may differ from the home configuration. `THREAD_MEMORY_ASYNC_START_TOKENS` supplies a single authoritative startup line. `THREAD_MEMORY_HANDOFF_LEAD_TOKENS` overrides the first lead. Only checks that fall after that first reminder are used.

Usage comes from the latest usable sample in a bounded rollout tail scan. Copied forks with an authoritative first-owned ordinal can be checked without counting inherited records. The hook skips reminders if it cannot verify the window boundary. A large new result, a long reply, or manual compaction can skip the save opportunity.

After verifying a reminder window, the hook can keep a read checkpoint per rollout file in SQLite. It checks the active file's identity and the bytes before the last complete line, then scans from that position. The checkpoint retains a bounded set of usage and turn records for the current window. It uses the bounded tail scan when appended records refer to turn details the checkpoint cannot verify, or when the file is replaced, shortened, or otherwise unverifiable. Compaction and rollback start a new window.

`memory write` and `memory patch` update the thread's note across compaction and rollback. SQLite checks the note revision at save time to protect concurrent edits.

Ask Codex to maintain a thread note, save progress before manual `/compact`, or read the note after compaction. Commands default to `CODEX_THREAD_ID`, the root or subagent's own thread. `memory write` creates or replaces the entire note with UTF-8 text from stdin. Notes over 8,192 bytes are shortened at a complete UTF-8 character, end in `[Summary truncated]`, and return `truncated: true`. `memory patch` applies a unified diff from stdin for a targeted edit, and rejects mismatches or output beyond the limit before saving. Read output is complete and can be piped through ordinary text filters.

Each edit records a version with a UTC maintenance timestamp. `memory read` returns the latest content and `updated_at`. For a known thread with no note at the requested time, `summary`, `updated_at`, and `effective_at` are all null. `memory history --limit 10` lists each version's `updated_at`, `effective_at`, and `bytes`. Pass `effective_at` or another RFC 3339 timestamp to `memory read --at TIME` to select the last version effective at or before that time. Both `read` and `history` accept one raw timestamp on stdin with `--at -`. For a copied note, `effective_at` is the fork's creation time and `updated_at` is the original maintenance time until the child edits the note.

Main-thread forks use the creation timestamp in the new thread's original verified rollout header to choose the parent's version. The first `SessionStart(fork)` or first memory access copies that version, including an empty result if the parent had no note at that time. Further reads and edits use the new thread's revisions, and a later main-thread fork can inherit them. If a verified fork's inheritance is unavailable, an explicit `memory write` can start its own note and returns `inheritance_unavailable` in the receipt. The note store and fork logic use local SQLite and rollout headers.

The native hook and the Python CLI and panel share `$CODEX_HOME/state/plugins/thread-memory/handoff.sqlite3`. Thread Memory opens it on the first state write, including a Hook diagnostic or a note edit. `PRAGMA user_version` identifies the schema. Version 1 commits its tables and schema version in one transaction, and the revision index supports latest and time-bounded reads by thread. The first durable note initialization includes earlier window note versions so history and fork-time lookups can still find them. The handoff commands default to the preceding window and accept `--current` to select the active one. After initialization, maintain the durable note with `memory`.

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

Open **Thread Memory** from Codex Desktop's sidebar to browse main threads with saved notes, including ordinary user forks. Choose **All**, **Active** (unarchived), or **Archived** and search by title or UUID. Sort newest first by **Note updated** (the default) or **Thread updated**. The latter uses the Codex thread index and falls back to the note time when the thread time is unavailable. Counts reflect the filters, and pagination follows the selected order. Select a thread to read or copy its current note. Threads with only legacy handoffs show the latest saved handoff. On narrow panels, **Back to threads** returns to the current filters, sort order, and page. The app reads titles and previews from the Codex thread index and can verify a thread's type from its rollout header when the index has no match.

The local stdio server's `handoff_manager` tool opens `ui://thread-memory/notes` as a global MCP Apps entrypoint. The plugin list uses `assets/thread-memory-icon.png`. The sidebar uses `skills/thread-memory/assets/thread-memory-entrypoint.png`. [Server implementation](../plugins/thread-memory/skills/thread-memory/scripts/rollout_handoff_app.py) · [Shared Codex MCP Apps guide](codex-mcp-apps.md)

Opening a new panel loads the directory. When the existing panel becomes visible again, it refreshes the current page and the selected note, keeping the search, filters, and sort order.

Cleanup covers notes and search index entries for deleted main threads and their deleted subagents, including threads that only have search entries. It requires a completed local Codex index and checks thread rows, spawn and attachment relationships, the session name index, and active and archived rollout names. Surviving evidence protects stored data for those threads. On confirmation it rechecks the selected IDs and initializes any surviving ordinary fork that still depends on the source note. When an uninitialized fork cannot be verified, the cleanup result identifies sources kept for protection. Codex deletes the spawn subtree together. It blocks deletion while a surviving attached thread or external rollout reference depends on the source. The local index has no retained deletion log, so cleanup infers deletion from the verified absence of all local records.

## Progressive reads

Start with locations and counts. Search within a likely window, time range, or turn, then read only the records needed. Run these examples from the repository root in PowerShell.

```powershell
$cli = 'plugins/thread-memory/skills/thread-memory/scripts/rollout.py'
$thread = '<thread-uuid>'
$since = '2026-11-20T14:00:00+08:00'
$until = '2026-11-20T14:30:00+08:00'

python $cli inspect --thread $thread | jq '{segments, checkpoint_count}'
python $cli lineage --thread $thread | jq '.fork_chain'
python $cli windows --thread $thread --since $since --until $until | jq '.items[] | {window, first_at, last_at, compacted_at}'
python $cli search --thread $thread --window 2 --ignore-case --limit 5 'imagegen' | jq '.items[] | {ref, line, text}'
python $cli read --thread $thread --segment '<name-or-id>' --lines 120:125 | jq '.items[]'
python $cli read --thread $thread --segment '<name-or-id>' --lines 122:122 --field-index 0 --chars 400:800 | jq '.items[]'
python $cli tool-input --thread $thread --id '<input-id>' --lines 8 --budget-chars 1000 | jq -r '.items[].text'
python $cli tool-output --thread $thread --id '<output-id>' --lines 10:20 | jq -r '.items[].text'
python $cli transcript --thread $thread --origin current --since $since --until $until --limit 24 --max-chars 140 | jq '{items: [.items[] | {role, text, ref}], next_cursor}'
python $cli images --thread $thread --segment '<name-or-id>' --lines 122:122 | jq -r '.items[].image_id'
python $cli export-image --thread $thread --id '<image-id>' --max-resolution 512 | jq -er '.images[0].thumbnail_file'
python $cli tokens --thread $thread --window 2 | jq '.totals'
python $cli recover --thread $thread --window 2 --max-messages 4 --max-images 0 | jq '{candidate_count, messages: [.messages[] | {role, text}]}'
```

Run with plain `python`. The CLI emits one compact UTF-8 JSON object on stdout and sends errors to stderr. Use `jq` to project only the fields you need. `inventory`, `search`, `read`, `instructions`, `transcript` in JSON mode, `images`, `attachments`, `windows`, both `tokens` detail modes, and tool detail line views return a page in `.items[]` and a `.next_cursor` that is `null` on the final page. Continue with `--cursor` set to `.next_cursor`. Keep the same rollout source and repeat the query filters for ordinary pagination. Tool detail cursors carry the ID and paging options. The default `--limit` is 20 for record pages. Text pages also default to a total `--budget-chars` of 4,000. `--max-chars` limits the excerpt for an individual record and defaults to 400 for `search` and `read` and 1,000 for `transcript`. JSON metadata and escaping add to the size of stdout.

Pass cursor strings through unchanged. Compact cursors for `search`, `read`, `transcript`, `windows`, and `tokens --by-summary` avoid repeating full rollout paths. Start a fresh page if you have a cursor from the earlier format for any of these commands or for tool details.

For rollout queries, `--output NEW_PATH` writes the result to a new file and returns a JSON receipt with `output` and `bytes`. Paged results also include `next_cursor` in the receipt, including `null` on the final page. File output uses the same page limits. Request each needed page with its own output path. For a readable chat excerpt, explicitly select `transcript --format markdown` with the relevant filters and add `--output NEW_PATH` to save it.

Pass `--thread UUID` for a local thread or `--rollout PATH` for an explicit input file. With neither flag, the CLI uses `CODEX_THREAD_ID`, which identifies the subagent in a subagent shell. To inspect the root from that shell, pass `--thread $env:CODEX_SESSION_ID` in PowerShell. Use `--codex-home PATH` for a specific Codex home. The CLI follows recorded `history_base` links. Repeat `--previous PATH` to locate ancestors referenced by those links when they are outside the Codex home. Run `<command> --help` for command-specific options.

## PowerShell and jq pipelines

Use PowerShell 7.4 or later for the native pipelines below. Reuse an argument array to keep the rollout source consistent between requests. `read --ref -`, `images --ref -`, and `attachments --ref -` read exactly one raw UTF-8 reference from stdin. `tool-input --id -` and `tool-output --id -` read one ID. `export-image --id -` and `export-audio --id -` read one or more IDs. Paged commands read one cursor with `--cursor -`. Use one raw UTF-8 line per value and one stdin consumer per invocation.

```powershell
$PSNativeCommandUseErrorActionPreference = $true
$ErrorActionPreference = 'Stop'
$source = @('--thread', $thread)

python $cli search @source --window 2 --limit 1 'imagegen' |
    jq -er '.items[0].ref' |
    python $cli read @source --ref - |
    jq '.items[0] | {line, fields}'

$toolPage = python $cli read @source --tool apply_patch --type custom_tool_call_output --limit 1 |
    jq -er 'first(.items[].output_id // empty)' |
    python $cli tool-output @source --id - --lines 8
$toolPage | jq -r '.items[].text'
if ($toolPage | jq -r '.next_cursor // empty') {
    $toolPage | jq -er '.next_cursor' |
        python $cli tool-output @source --cursor - |
        jq -r '.items[].text'
}

python $cli transcript @source --role user --since $since --until $until --limit 5 |
    jq -er 'first(.items[] | select(.image_count > 0) | .ref)' |
    python $cli images @source --ref - |
    jq -er '.items[].image_id' |
    python $cli export-image @source --id - --max-resolution 512 |
    jq '{unknown_ids, images: [.images[] | {image_id, thumbnail_file, thumbnail_width, thumbnail_height, export_error}]}'

$chat = @('--origin', 'current', '--window', 'current', '--role', 'assistant', '--limit', '1')
$page = python $cli transcript @source @chat
$cursor = $page | jq -r '.next_cursor // empty'
if ($cursor) {
    $page | jq -er '.next_cursor' |
        python $cli transcript @source @chat --cursor - |
        jq -r '.items[].text'
}
```

`jq -er` writes unquoted values and exits nonzero when a required projection is empty or `null`. PowerShell's native command error handling stops on failed commands. An empty match page or a record without attachments is a successful query, so use `jq -r` when zero results are expected. `.next_cursor // empty` gives the `if` test an empty value on the final page.

## Errors and exit codes

Fatal errors write one compact UTF-8 JSON line to stderr with an `error` object. The object has `code` and `message`, and may include `hint`, `path`, or `line`. Messages are capped at 400 characters plus an ellipsis. Malformed JSONL can report the file path and physical line with a hint to retry using `--salvage`. `--help` prints plain-text help.

| Exit code | Meaning |
| --- | --- |
| `0` | Success, including an empty result. A batch image export can report individual failures in its result. |
| `2` | `invalid_arguments`, such as a malformed option value. |
| `1` | `invalid_input`, `invalid_rollout`, `not_found`, `permission_denied`, `output_exists`, `io_error`, or `runtime_error`. |
| `130` | `interrupted`. |
| `141` | The downstream pipe closed. This exit is quiet. |

When handling failures in PowerShell, capture stderr separately and save `$LASTEXITCODE` immediately after running the CLI. `jq` reports its own status, so use the CLI status to decide which stream to parse. This example uses an explicit exit guard in a scope with native command exception handling disabled.

```powershell
& {
    $PSNativeCommandUseErrorActionPreference = $false
    $stderr = New-TemporaryFile
    try {
        $result = python $cli read --thread $thread --limit 1 2> $stderr.FullName
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

`windows`, `search`, `read`, `transcript`, `images`, and `tokens` accept `--origin all`, `--origin current`, `--origin inherited`, or `--origin unknown`. The default is `all`. `current` includes the selected thread's own records in older segments. `inherited` includes parent segments reached through `history_base` and copied records in a child rollout whose ordinals precede `subagent_history_start_ordinal`. Legacy forks without a reliable boundary use `unknown` for ambiguous records and `inherited` for explicitly marked copies.

For copied records, `forked_from_thread_id` reports the recorded fork parent. `timestamp_origin: copied_at` means the timestamp describes when the child recorded the copy. Use the parent rollout to query the original message time. `windows` filters a closed window by the origin of its checkpoint, and its start can fall in a different segment. Use `tokens --window N --origin current` to count only the selected thread's usage inside that window.

## Compaction windows and chat

`inspect` reports discovered segments, `checkpoint_count`, and at most the five most recent checkpoints. Use `windows` to page through the full list. Each item reports source locations for `read`, `first_at` and `last_at` for the earliest and latest usable timestamps in the window, and `compacted_at` for the checkpoint timestamp. Add `--window current` to inspect the open window after the latest checkpoint. Its `compacted_at` is `null`. Time bounds select windows that overlap the requested interval and skip windows without usable timestamps.

`jq` projects missing keys as `null`. Use `has()` when the keys must exist but may legitimately be null. Use `jq -e` with a predicate that checks what the caller requires. This example requires one window item with all three time keys and a known checkpoint time.

```powershell
python $cli windows --thread $thread --window 2 |
    jq -e '.items | length == 1 and (.[0] | has("first_at") and has("last_at") and has("compacted_at") and (.compacted_at | type == "string"))'
```

`transcript` returns user and assistant messages with their recorded timestamps and source locations, including user-facing assistant messages recorded as explicit async delivery events. Use `--role user` or `--role assistant` to focus on one speaker. Use `search` or `read` for system and developer instructions, tool metadata, compaction records, or other legacy message events.

Use `transcript --last N` for the newest messages in the selected scope, returned in chronological order. It uses the normal text budgets. For forward pagination, omit `--last` and use `--cursor`. Use `--phase final`, `--phase commentary`, or `--phase partial` to select assistant messages with that recorded phase. Messages without a recorded phase are excluded by this filter.

```powershell
python $cli transcript --thread $thread --origin current --last 6 --phase final --max-chars 240 |
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
python $cli read --thread $thread --role system --limit 3 --max-chars 240 |
    jq '.items[] | {kind, item_type, role, line, fields}'
python $cli search --thread $thread --role developer --limit 5 --max-chars 240 'workspace' |
    jq '.items[] | {kind, item_type, role, line, ref, text}'
```

Use `instructions --window N` for system and developer messages in a compaction checkpoint's recorded `replacement_history`. Use `windows` to find the checkpoint number. Repeat `--role` to select both roles explicitly. `checkpoint_item` is the zero-based index in the full snapshot. Pass that index to `--item` and use `--chars START:END` for a zero-based, half-open slice. Use `--limit`, `--max-chars`, and `--budget-chars` to bound excerpts and `--cursor` to continue with the same checkpoint and filters.

```powershell
python $cli instructions --thread $thread --window 2 --role developer --limit 5 |
    jq '{items: [.items[] | {role, checkpoint_item, text_total_chars}], next_cursor}'
python $cli instructions --thread $thread --window 2 --item 3 --chars 0:240 |
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
python $cli inventory --thread $thread --window 2 --limit 8 |
    jq '{items: [.items[] | {kind, item_type, count, example}], next_cursor}'
python $cli read --thread $thread --window 2 --metadata-only --limit 8 |
    jq '.items[] | {kind, item_type, line, body_available, ref, input_id, output_id}'
```

`search` matches literal text by default. Use `--regex` for Python regular expressions and `-i` or `--ignore-case` for case-insensitive matching. `-B N` or `--before N` and `-A N` or `--after N` add up to 20 surrounding records in each direction, subject to the page text budget.

For a single uncompressed Codex rollout in the selected home's `sessions` or `archived_sessions` directory, the first time- or window-scoped `search` builds a metadata cache in `$CODEX_HOME/state/plugins/thread-memory/rollout-index.sqlite3`. The rollout header must identify the owner in the filename. The cache stores timestamps, physical offsets, compaction checkpoints, and the context needed to annotate each record. Later searches extend the cache with complete appended rows and select candidate offsets in SQLite, then seek to the original JSONL records for text matching. A change in file identity or the checked bytes triggers a rebuild. Line ranges and cursor continuations can reuse a prepared index. An indexed continuation starts near the cursor and includes any requested preceding context. External or unverified files, unscoped first pages, multi-segment lineages, compressed files, named tool matching, and `--salvage` use the streaming reader. The first indexed search can take longer while it builds the cache.

Each hit reports `ref`, `field`, `field_index`, `match_start`, `match_end`, `text_offset`, and `text_total_chars`. Use `read --ref REF` to reopen the matching field. For a large field, use `--chars START:END` to read a slice. You can also select one physical line and use zero-based `--field-index N` or `--field NAME`. When a field selector returns exactly one field, the ref reopens that field. Character offsets are zero-based, include `START`, and exclude `END`. Use adjacent ranges to read additional slices within the page budget.

| Selector | Scope |
| --- | --- |
| `--window N` | Records after the previous compaction checkpoint through checkpoint `N`, as shown by `windows`. |
| `--window 0` | An inherited initial checkpoint when the rollout records it as window zero. |
| `--window current` | The physical records after the latest compaction checkpoint. |
| `--since TIME` and `--until TIME` | RFC 3339 timestamps with an explicit offset or `Z`. The interval includes `--since` and excludes `--until`. Original timestamps are preserved in results. |
| `--segment NAME_OR_ID` | A rollout segment by its name or ID. |
| `--lines START:END` | An inclusive, 1-based range of physical JSONL lines in each selected segment. |
| `--turn ID` | A recorded turn. |
| `--type TYPE` or `--role ROLE` | Selected record types or message roles. Repeat a flag to select multiple values. |
| `--tool NAME` | Exact tool name for `search` and `read`, applied before pagination. |
| `--limit N`, `--max-chars N`, `--budget-chars N` | Maximum returned items, excerpt characters per record, and excerpt characters per page. |

Use the source segment and line number from the result to cite or revisit a record. A direct `read --segment NAME_OR_ID --lines N:N` can report a record that has metadata but no readable fields. Search operates on extracted text and image references, so image data URLs stay out of the excerpts. Search and read inspect physical records, including turns later rolled back. Window listings mark inferred window numbers for older checkpoints that did not write one.

## Record references

`search`, `read`, and JSON `transcript` put an opaque `ref` on each item. `inventory` puts one in each group's `example`. Pass a ref to `read --ref REF` with the same rollout source to reopen a record, a selected field, or a transcript message. `read --ref` returns text in `.items[].fields[].text` for all these sources. A ref checks the raw JSONL record bytes excluding the final line terminator and the working directory used to resolve attachments. Changes to the record or its working directory can make a ref stale. Use `images --ref REF` or `attachments --ref REF` to list media on that exact record. For a transcript ref, the lookup follows the transcript message's visible attachment projection. A related tool call or attachment on another record requires its own ref or a scoped catalog query.

Use `--ref -` to pipe one ref from `jq -er`. Record scope selectors such as `--window`, `--turn`, `--since`, `--until`, `--segment`, and `--lines` are replaced by the ref. Get a fresh ref if the underlying record is rewritten or no longer resolves under the selected source.

## Tool arguments and returns by ID

User messages and assistant replies remain directly available through `search`, `read`, and `transcript`. For tool records, `search`, its surrounding records, and `read` expose metadata such as the tool name and `call_id` when available, source location, and `input_id` or `output_id`. Search matches tool metadata only. Argument values and return bodies require their respective IDs, including when using `read --field` or `read --field-index`.

`search --tool NAME` and `read --tool NAME` prefer the name recorded on the tool record. For an unnamed return, the filter can use a unique compatible earlier call in the same segment and history boundary, including a call outside the selected line range. Ambiguous or incompatible calls leave the tool name unknown. Read the resolved label with `read --tool NAME | jq -r '.items[].tool_name'`. Search patterns and field selectors operate on recorded fields.

Pass `input_id` to `tool-input --id ID` or `output_id` to `tool-output --id ID` with the same rollout source. `--lines N` sets the maximum number of text lines per page and defaults to 20. Use `--lines START:END` to jump directly to a range of text lines across fields. The range is 1-based and inclusive, and it replaces the per-page line count. For example, `--lines 10:20` starts at line 10 without a cursor. For `read`, `--lines START:END` instead selects physical JSONL records.

The 4,000-character page cap applies to both forms. Set `--budget-chars` on the first page to adjust it. A line that cannot fit on an empty page is split across pages. To resume, pass the returned `.next_cursor` as `--cursor CURSOR` or `--cursor -` on the same command and rollout source. The cursor restores the ID, line selection, and character budget, so omit `--id`, `--lines`, and `--budget-chars` on continuation. A tool cursor checks the raw JSONL record bytes excluding the final line terminator. Appending later records preserves the cursor, while editing or reformatting the selected record can invalidate it. Start a fresh page to replace a stale tool detail cursor. For large payloads, write pages to separate files with `--output NEW_PATH` and search or read those files selectively. Use the image commands for media stored as image blocks.

For structured payloads, pass `--pointer JSON_POINTER` with the same `--id` to `tool-input` or `tool-output`. This reads a typed JSON `.value` from the supported fields. The empty pointer `--pointer ''` selects the available root. Use `~0` for `~` and `~1` for `/` in a key. Embedded media, encrypted content, and internal fields are excluded. If the JSON value exceeds `--budget-chars`, select a narrower pointer or increase the budget.

```powershell
python $cli tool-input --thread $thread --id '<input-id>' --pointer '/arguments/nested' --budget-chars 800 |
    jq '.value'
```

## Attachment lookup and export

`images` lists image IDs, timestamps, and source locations without decoding or exporting the media. IDs locate an occurrence using the rollout position and a fingerprint of the image data or reference. The same image can appear under multiple IDs. Run `images` again to get fresh IDs after migrating or rewriting a rollout. Combine window and time filters, or select a source with `--kind inline`, `--kind local`, or `--kind reference`. Use `images --ref REF` to resolve attachments from a selected record.

`images --role ROLE` narrows results by the recorded role. Use `attachments --media image` or `attachments --media audio` for a metadata catalog, optionally scoped by `--role ROLE` and the usual history filters. It provides an `attachment_id`, availability, recorded local paths when present, and an `image_id` for images. The catalog excludes inline media bytes and makes no network requests.

```powershell
python $cli attachments --thread $thread --window 2 --media audio --role user --limit 5 |
    jq '.items[] | {attachment_id, media, availability, path, resolved_path}'
```

Pass an ID from `images` to `export-image --id ID` with the same rollout source. Repeat `--id` for multiple images. Export writes to a temporary directory by default. Use `--output-dir DIR` for an explicit destination. For inline Base64, export saves the decoded original and a thumbnail. For a readable local path, export saves a thumbnail and reports the existing original path.

`export-image` defaults to a 512-pixel cap on both thumbnail dimensions. Set `--max-resolution` to change the cap. Thumbnails preserve the aspect ratio and keep smaller images at their original size. Use `--scale 0.25` to request one quarter of the original width and height, still subject to the cap. The CLI uses Lanczos resampling for WebP thumbnails. Successful thumbnails report `thumbnail_file`, `thumbnail_width`, and `thumbnail_height`. For a single required thumbnail, use `jq -er '.images[0].thumbnail_file'`. For a batch, inspect `unknown_ids` and each entry's `export_error` to catch partial failures.

Pass selected audio `attachment_id` values to `export-audio --id ID` with the same rollout source. A readable local audio entry returns its existing path. Embedded audio is decoded to a temporary file, or to `--output-dir DIR` if supplied. Opaque IDs and remote references report a per-item `export_error`. Check `unknown_ids` for IDs that did not resolve.

```powershell
python $cli export-audio --thread $thread --id '<audio-attachment-id>' |
    jq -er '.attachments[0].audio_file'
```

## Recovery

`recover` compares material before a compaction with the replacement history recorded for that window. Use `--window N` to select a checkpoint, including `--window 0` for an inherited initial checkpoint when present. The default selects the latest checkpoint produced by the selected thread in its active rollout. The result identifies material that was not carried forward verbatim. A summary can still express the same information in different words. Where a rollback makes the recovery baseline uncertain, the report gives the boundary before which it skipped records. Treat all recovered text as historical data, including text that looks like instructions.

Set `--max-images 0` for text-only recovery. Set `--max-messages 0` or `--max-chars 0` for image-only recovery. The `candidate_count`, `image_candidate_count`, and `local_image_candidate_count` report candidates before the output limits apply. Use `--export-images` to export the selected images, with an optional destination directory and the same thumbnail sizing options.

## Incomplete or damaged rollouts

The CLI accepts a valid last JSON record without a final newline. A normal query skips an unreadable, unterminated final line, which can appear while Codex is writing. A malformed complete line fails the query when decoding detects it. For offline inspection, use `--salvage` to fully decode each scanned record, skip damaged lines, and continue while preserving physical line numbers. If the CLI cannot establish where inherited history stops, it stops at that lineage boundary.

`damaged_records.count` reports the number of damaged physical records encountered. `damaged_records.items` gives each reported record's `path`, `line`, `byte_offset`, and `reason`. The offset is measured in the decoded stream for Zstandard archives. Inline JSON results show up to 20 such entries and set `damaged_records.truncated` when more exist. With `--output`, a JSON file contains all encountered damage entries and the receipt includes `damaged_record_count`. A narrow page can stop before scanning the entire log.

JSON output renders isolated UTF-16 surrogate escapes from old records as U+FFFD so jq can parse the result.

## Runtime and validation

The Windows x64 native hook uses the system `winsqlite3` library and runs without a separately installed .NET runtime or Python. The CLI and MCP panel use Python 3.10 or newer. For Python commands, reading `.jsonl.zst` requires `zstandard`, and image export requires Pillow 9.1 or newer with WebP support. Reading Codex configuration from Python 3.10 can also require `tomli`.

In **Thread Memory**, **Dependencies** shows which optional features the plugin's Python can run. **Install missing dependencies** uses that interpreter's pip and standard `site-packages` directory. It installs wheels for the unavailable packages shown in the panel. Installation requires network access, pip, and write permission to that Python installation.

Window and token queries fully decode records when they need their payloads. Skipped payloads are checked for envelope closure. Window queries and image recovery reuse byte offsets within one invocation for uncompressed JSONL. Zstandard archives are read sequentially. A scan that reaches a truncated frame reports the affected archive as `invalid_rollout`.

### Build and validate

From the repository root on Windows x64, use the .NET 10 SDK and Visual Studio C++ build tools. Include `bin/Thread Memory Hook.exe` and `THIRD-PARTY-NOTICES.txt` in the plugin package.

```powershell
$plugin = 'plugins/thread-memory'
$artifacts = Join-Path (Resolve-Path .) 'tmp/thread-memory-native'
$publish = Join-Path $artifacts 'publish'
dotnet publish "$plugin/src/thread-memory-hook.csproj" -c Release -r win-x64 --artifacts-path $artifacts -o $publish
$publishExit = $LASTEXITCODE
if ($publishExit -ne 0) { throw "Native AOT publish failed ($publishExit)" }
New-Item -ItemType Directory -Path "$plugin/bin" -Force | Out-Null
Copy-Item "$publish/Thread Memory Hook.exe" "$plugin/bin/"
```

Run the Python suite after packaging the executable. Hook integration tests send UTF-8 JSON on stdin to `bin/Thread Memory Hook.exe` and verify its output and shared SQLite state through the Python CLI. Set `THREAD_MEMORY_TEST_HOOK_EXE` to test another published binary in isolation.

```text
python -m unittest discover -s plugins/thread-memory/tests -p "test_*.py"
python <skill-creator>/scripts/quick_validate.py plugins/thread-memory/skills/thread-memory
python <plugin-creator>/scripts/validate_plugin.py plugins/thread-memory
```
