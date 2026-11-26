# Compaction and usage

## Find the checkpoint

`inspect` lists recent checkpoints. Use `windows --limit 8` for a paged index of `window`, `first_at`, `last_at`, and `compacted_at`. Use the numbered checkpoint with `recover` or `instructions`. Window `0` can refer to a recorded inherited initial checkpoint. The open window follows the latest checkpoint and has `compacted_at: null`. Run `& $cli windows --help` for scope options, including time ranges that match overlapping windows.

## Recover a missing detail

Use `search` or `transcript` when you already know the phrase or message you need. For a small batch of omitted excerpts, use the `recover` example below. With no window, recovery selects the latest eligible checkpoint written by the selected thread in its active rollout. Run `& $cli recover --help` for checkpoint selection, limits, and preview export. Pass a recovered `image_id` to `export-image --id ID --original` for the full-resolution file.

```powershell
$recovery = & $cli recover @source --max-images 0 --max-messages 4 --max-chars 1200
$recoverExit = $LASTEXITCODE
if ($recoverExit -eq 0) {
    $recovery | jq '{status, candidate_count, messages: [.messages[] | {rollout, line, role, text}]}'
}
```

If `recover` exits nonzero, inspect its JSON error on stderr. On success, check `.status` and candidate counts before reading `.messages`. The comparison reports material absent verbatim from the stored replacement history. A summary can express the same information in different words. If the replacement history is unavailable or rollback or damage limits the comparison, switch to a scoped history read and check the reported boundaries. For malformed records, retry with `--salvage` when needed and report any relevant `damaged_records.count` or `missing_base_rollouts`.

## Inspect saved instructions or token counts

`instructions --window N --role developer --limit 5` lists recorded developer messages from the checkpoint snapshot. Select `--item N --chars 0:240` to read an excerpt by its `.checkpoint_item` in the full replacement history. Run `& $cli instructions --help` for roles and excerpt options.

`tokens --window N` reports `.totals` for recorded usage. Run `& $cli tokens --help` for response and summary detail options. A summary count comes from its matched compaction response, and `null` means unavailable. Reasoning counts describe whole responses, and summary counts can overlap output totals. Prefer recorded `total_tokens` for overall usage.
