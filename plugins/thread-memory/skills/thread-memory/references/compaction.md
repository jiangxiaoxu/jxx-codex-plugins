# Compaction and usage

## Read part of a thread note

Use `$cli` from the [Skill](../SKILL.md). This example reads lines 10 through 20 of the note.

```powershell
$noteLines = @(& $cli memory read)
$readExit = $LASTEXITCODE
if ($readExit -eq 0) {
    $noteLines | Select-Object -Skip 9 -First 11
} else {
    Write-Error "memory read failed ($readExit)" -ErrorAction Continue
}
```

## Patch a thread note

Use `memory patch` to apply a unified diff to the current note. Read the note first and match the hunk line numbers and context to the saved Markdown. Generate diffs that repeat long lines inside PowerShell from the Markdown you just read. If the note changed and the patch no longer applies, reread the note and rebuild the diff.

```powershell
$patch = @'
--- a/note.md
+++ b/note.md
@@ -1,2 +1,2 @@
 ## Progress
-- [ ] Verify the panel
+- [x] Verify the panel
'@
$patch | & $cli memory patch
```

A mismatch, empty result, or result over 25,600 UTF-8 bytes leaves the stored note unchanged.
Run `& $cli memory patch --help` for command syntax and exit behavior.

## Find the checkpoint

`inspect` lists recent checkpoints. Use `windows --limit 8` for a paged index of `window`, `first_at`, `last_at`, and `compacted_at`. Use the numbered checkpoint with `recover` or `instructions`. Window `0` can refer to a recorded inherited initial checkpoint. The open window follows the latest checkpoint and has `compacted_at: null`. Run `& $cli windows --help` for scope options, including time ranges that match overlapping windows.

## Recover a missing detail

Use `search` or `transcript` when you already know the phrase or message you need. For a small batch of omitted excerpts, use the `recover` example below. With no window, recovery selects the latest eligible checkpoint written by the selected thread in its active rollout. Run `& $cli recover --help` for checkpoint selection, limits, and preview export. Pass a recovered `image_id` to `export-image --id ID --original` for the full-resolution file.

```powershell
& $cli recover @source --max-images 0 --max-messages 4 --max-chars 1200 |
    jq '{status, candidate_count, messages: [.messages[] | {rollout, line, role, text}]}'
```

Check `.status` and candidate counts before reading `.messages`. The comparison reports material absent verbatim from the stored replacement history. A summary can express the same information in different words. If the replacement history is unavailable or rollback or damage limits the comparison, switch to a scoped history read and check the reported boundaries. For malformed records, retry with `--salvage` when needed and report any relevant `damaged_records.count` or `missing_base_rollouts`.

## Inspect saved instructions or token counts

`instructions --window N --role developer --limit 5` lists recorded developer messages from the checkpoint snapshot. Select `--item N --chars 0:240` to read an excerpt by its `.checkpoint_item` in the full replacement history. Run `& $cli instructions --help` for roles and excerpt options.

`tokens --window N` reports `.totals` for recorded usage. Run `& $cli tokens --help` for response and summary detail options. A summary count comes from its matched compaction response, and `null` means unavailable. Reasoning counts describe whole responses, and summary counts can overlap output totals. Prefer recorded `total_tokens` for overall usage.
