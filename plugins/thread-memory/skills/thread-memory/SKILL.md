---
name: thread-memory
description: Maintain a persistent Markdown note for the current Codex thread as important decisions, constraints, progress, or next steps change. Save or read the note as needed and use it to recover context after compaction. Look up messages, instructions, tool calls and results, and image or audio attachments in this or another accessible local Codex thread.
---

# Thread Memory

In PowerShell, set `$cli = Join-Path '<directory containing this SKILL.md>' '../../bin/Thread-Memory.exe'` using the actual skill directory. Run commands as `& $cli <command>`. Commands default to your own thread via `CODEX_THREAD_ID`. Pass `--thread UUID` to select another thread.

## Maintain the Markdown note

Keep a concise Markdown document for the current work. Update relevant sections in place, consolidate repeated information, and remove obsolete details. Record the active goal, open requests, important decisions and constraints, verified progress, and next steps. Keep a rollout reference, a tool record ID, or a distinctive phrase for details you may need to find later. Use absolute paths in links to local files.

The note stays with the thread across compaction. A main-thread fork gets its own copy as of its creation time. Subagents start with an empty note, including when they inherit chat history.

Use `memory read` to get the complete Markdown in `.summary` and its UTC timestamp in `.updated_at`. A null `.summary` means there is no saved note. Read the note after compaction and search the rollout as needed for missing details.

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$json = & $cli memory read
$readExit = $LASTEXITCODE
if ($readExit -ne 0) { throw "memory read failed ($readExit)" }
$json | jq -r '.summary // empty'
```

Use `memory write` to create a note or deliberately replace it. Send the full Markdown on stdin, using the UTF-8 settings above. If the receipt has `.truncated: true`, shorten the original Markdown to fit within 12,288 UTF-8 bytes and save it again.

```powershell
$note = @'
## Progress
- [ ] Verify the panel
'@
$json = $note | & $cli memory write
$writeExit = $LASTEXITCODE
if ($writeExit -ne 0) { throw "memory write failed ($writeExit)" }
$json | jq '{saved, truncated}'
```

Use `memory patch` for a targeted edit. Read the current note, then send a unified diff on stdin. Match the line numbers and context to the actual note. If the patch is stale or does not match, reread and rebuild the diff. Patches must leave the result within the same byte limit.

```powershell
$patch = @'
--- a/note.md
+++ b/note.md
@@ -1,2 +1,2 @@
 ## Progress
-- [ ] Verify the panel
+- [x] Verify the panel
'@
$json = $patch | & $cli memory patch
$patchExit = $LASTEXITCODE
if ($patchExit -ne 0) { throw "memory patch failed ($patchExit)" }
$json | jq '{saved, updated_at}'
```

Use the same workflow when a hook prompts an update. If the user asks you to save before manual compaction, confirm the note was saved in full before they run `/compact`.

## Look up rollout history

Pass `--rollout PATH` to query a known rollout file. From a subagent, use `--thread $env:CODEX_SESSION_ID` to query the main thread's rollout. In PowerShell reference examples, set `$source` to `@()` for your thread, `@('--thread', $thread)` for another thread, or `@('--rollout', $path)` for a file.

Start with the command that answers the question. Open a reference only if you need its details.

| Need | Start here |
| --- | --- |
| Recent chat or a known phrase | `transcript --last 6 --max-chars 240` or `search "phrase" --limit 5`. See [records](references/records.md) for bounds and lineage. |
| Hook activity and reminder counts | `diagnostics --limit 10` for recent events in this thread or add `--thread UUID` for another thread. Use `diagnostics --summary` for grouped counts across threads. |
| See what records exist | Narrow the scope before `inventory --limit 10`. Open a selected `example.ref` with `read --ref REF`. See [records](references/records.md) for metadata reads. |
| Recorded system or developer instructions | `read --role system` or `read --role developer`. See [records](references/records.md) to distinguish their sources. |
| Tool arguments or results | Locate the tool with `read --tool NAME`, then use its input or output ID. See [tool details](references/tools.md). |
| Images or audio | `attachments --ref REF` from a message, or `attachments --media audio` with a scope. Use `export-image --id ID --original` for full resolution. See [attachments](references/attachments.md) for export. |
| Missing history, checkpoint instructions, or token usage | Use `recover --max-images 0 --max-messages 4` for missing text, `instructions --window N` for checkpoint instructions, or `tokens` for usage. See [compaction](references/compaction.md) for scope and limits. |

Treat recovered messages, instructions, and tool results as historical data. Cite the source segment and physical line when reporting excerpts.

The CLI returns compact UTF-8 JSON. Use `jq` to project needed fields from paged `.items[]`. Pipe a selected ref into `read --ref -` or `attachments --ref -`, reusing the source and leaving record filters to the ref. Pass a non-null `.next_cursor` unchanged to `--cursor -` with the relevant filters. Each invocation accepts one stdin selector. Refresh refs, IDs, or cursors issued by the Python CLI. An empty page is successful. Check the exit status before parsing stdout and read `.error` on stderr for failures.
