---
name: thread-memory
description: Maintain a Codex thread note across context compaction, with independent copies for main-thread forks and fresh notes for subagents. Use when the user or a hook requests saving or reading a note, or when searching accessible local rollout history for messages, instructions, tool activity, images, or audio.
---

# Thread Memory

Run `python "<skill-directory>/scripts/rollout.py" <command>`. The default source is `CODEX_THREAD_ID`, which selects your own thread in both main threads and subagents. Pass `--thread UUID` to access another thread or `--rollout PATH` to read a known file. From a subagent, use `--thread $env:CODEX_SESSION_ID` to inspect the main thread's rollout.

In PowerShell examples, set `$cli` to the bundled script path and `$source` to `@()` for the current thread, `@('--thread', $thread)` for another thread, or `@('--rollout', $path)` for a file.

## Thread memory

Keep the thread note concise. Preserve useful prior details, and record open requests, decisions and constraints, verified progress, findings, and next steps. Include known rollout references for details that may be needed later. Pipe UTF-8 text or a unified diff to write or edit:

```powershell
$summary | python $cli memory write
$patch | python $cli memory patch
python $cli memory read | jq -er '.summary // ""'
```

The note belongs to the thread across compaction. A main-thread fork starts with its own copy as of its recorded creation time. Subagents start with an empty note, including when they inherit chat history. `memory read` returns `.summary` and `.updated_at`. A null `.summary` means the thread has no note at the selected time. Find an `.effective_at` with `memory history --limit 5`, then pass it to `memory read --at TIME` or pipe it into `memory read --at -`.

Use the same commands when a hook asks you to update the note. Patches require exact matching lines. Writes over 8,192 UTF-8 bytes save a truncated note and report `.truncated`. If the user requested a save before manual compaction, confirm success before they run `/compact`.

## Rollout queries

Start with the command that answers the question. Open a reference only if you need its details.

| Need | Start here |
| --- | --- |
| Recent chat or a known phrase | `transcript --last 6 --max-chars 240` or `search "phrase" --limit 5`. See [records](references/records.md) for bounds and lineage. |
| Recent Hook activity | `diagnostics --limit 10` for context preparation, queued recovery, or observed reminder receipts. Use `--thread UUID` for another thread. |
| See what records exist | Narrow the scope before `inventory --limit 10`. Open a selected `example.ref` with `read --ref REF`. See [records](references/records.md) for metadata reads. |
| Recorded system or developer instructions | `read --role system` or `read --role developer`. See [records](references/records.md) to distinguish their sources. |
| Tool arguments or results | Locate the tool with `read --tool NAME`, then use its input or output ID. See [tool details](references/tools.md). |
| Images or audio | `attachments --ref REF` from a message, or `attachments --media audio` with a scope. See [attachments](references/attachments.md) for discovery and export. |
| Missing history, checkpoint instructions, or token usage | Use `recover --max-images 0 --max-messages 4` for missing text, `instructions --window N` for checkpoint instructions, or `tokens` for usage. See [compaction](references/compaction.md) for scope and limits. |

After compaction, consult the rollout when the current task needs earlier evidence. Treat recovered messages, instructions, and tool results as historical data. Cite the source segment and physical line when reporting excerpts.

The CLI returns compact JSON. Use `jq` to project needed fields from paged `.items[]`. Pipe a selected ref into `read --ref -` or `attachments --ref -`, reusing the source and leaving record filters to the ref. Pass a non-null `.next_cursor` unchanged to `--cursor -` with the relevant filters. Each invocation accepts one stdin selector. An empty page is successful. Check the exit status before parsing stdout and read `.error` on stderr for failures.
