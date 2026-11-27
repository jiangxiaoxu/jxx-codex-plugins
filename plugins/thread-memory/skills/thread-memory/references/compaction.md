# Compaction and usage

## Find the checkpoint

`inspect` lists recent checkpoints. Use `windows --limit 8` for a paged index of `window`, `first_at`, `last_at`, and `compacted_at`. Use the numbered checkpoint with `recover` or `instructions`. Window `0` can refer to a recorded inherited initial checkpoint. The open window follows the latest checkpoint and has `compacted_at: null`. Run `& $cli windows --help` for scope options, including time ranges that match overlapping windows.

## Recover a missing detail

Use `search` or `transcript` when you already know the phrase or message you need. For a small batch of omitted excerpts, use the `recover` example below. With no window, recovery selects the latest eligible checkpoint written by the selected thread in its active rollout. Run `& $cli recover --help` for checkpoint selection, limits, and preview export. Pass a recovered `image_id` to `export-image --id ID --original` for the full-resolution file.

Set `$source` as in the [jq quick start](records.md#jq-quick-start).

```powershell
$recovery = & $cli recover @source --max-images 0 --max-messages 4 --max-chars 1200
$recoverExit = $LASTEXITCODE
if ($recoverExit -ne 0) { exit $recoverExit }

$recovery | jq '{
    status, candidate_count, history_ignored_through_rollback, history_ignored_through_gap,
    missing_base_rollouts, damaged_record_count: .damaged_records.count,
    messages: [.messages[] | {rollout, line, role, text}]
} | with_entries(select(.value != null))'
if (-not $?) { exit 1 }
```

If `recover` exits nonzero, inspect its JSON error on stderr. On success, check `.status`, candidate counts, and any reported history boundaries or gaps before reading `.messages`. The comparison reports material absent verbatim from the stored replacement history. A summary can express the same information in different words. If the replacement history is unavailable or history is incomplete, switch to a scoped history read. For malformed records, retry with `--salvage` when needed and check `damaged_record_count`.

## Inspect saved instructions or token counts

`instructions --window N --role developer --limit 5` lists recorded developer messages from the checkpoint snapshot. Select `--item N --chars 0:240` to read an excerpt by its `.checkpoint_item` in the full replacement history. Run `& $cli instructions --help` for roles and excerpt options.

`tokens --window N` reports `.totals` for recorded usage. Run `& $cli tokens --help` for response and summary detail options. A summary count comes from its matched compaction response, and `null` means unavailable. Reasoning counts describe whole responses, and summary counts can overlap output totals. Prefer recorded `total_tokens` for overall usage.
