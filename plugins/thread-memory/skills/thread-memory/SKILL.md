---
name: thread-memory
description: Keep a concise note for the current Codex thread and update it when important decisions, constraints, progress, or next steps change. Read the note as needed during work and use it to recover context after compaction. Look up messages, instructions, tool calls and results, and image or audio attachments in this or another accessible local Codex thread.
---

# Thread Memory

In PowerShell, set `$cli = Join-Path '<directory containing this SKILL.md>' '../../bin/Thread-Memory.exe'` using the actual skill directory. Run commands as `& $cli <command>`. Commands default to your own thread via `CODEX_THREAD_ID`. Pass `--thread UUID` to select another thread.

## Maintain the note

Keep a concise note of the current work. Update existing sections in place, consolidate repeated information, and remove obsolete details. Record the active goal, open requests, important decisions and constraints, verified progress, and next steps. Keep a rollout reference, a tool record ID, or a distinctive phrase from a message for details you may need to retrieve later.

Use `memory write` to create or replace the whole note and `memory patch` for a targeted edit to an existing note. Read the current note first if you need its contents. Pass UTF-8 text or a unified diff on stdin.

```powershell
& $cli memory read | jq -er '.summary // ""'
$summary | & $cli memory write
$patch | & $cli memory patch
```

The note belongs to the thread across compaction. A main-thread fork starts with its own copy as of its recorded creation time. Subagents start with an empty note, including when they inherit chat history. `memory read` returns the current `.summary` and `.updated_at`. A null `.summary` means the thread has no saved note.

Use the same commands when a hook asks you to update the note. Patches require exact matching lines and a result within 12,288 UTF-8 bytes. Writes over that limit save a truncated note and report `.truncated`. If the user requested a save before manual compaction, confirm success before they run `/compact`.

After compaction, follow the recovery hint when available. Otherwise, read the full note with `memory read` to resume. Search the rollout for missing details as needed.

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
