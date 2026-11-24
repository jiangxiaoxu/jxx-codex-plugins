# Compaction and usage

## Edit a thread note

`memory read` returns the complete `.summary` when a note exists. Filter it in the shell. Use `memory patch` with a UTF-8 unified diff on stdin to edit the current thread note.

```powershell
& $cli memory read | jq -er '.summary // ""' | Select-Object -Skip 9 -First 11

@'
--- a/memory
+++ b/memory
@@ -3 +3 @@
-Next: Draft the test.
+Next: Run the test.
'@ | & $cli memory patch
```

Hunk locations and original lines must match. A mismatch, empty result, or result over 25,600 UTF-8 bytes leaves the stored note unchanged.

## Find the checkpoint

`inspect` lists recent checkpoints. Use `windows --limit 8` for a paged index of `window`, `first_at`, `last_at`, and `compacted_at`. Time bounds on `windows` select overlapping windows. `windows --window current` describes records after the latest checkpoint and has `compacted_at: null`. Use the numbered checkpoint with `recover` or `instructions`. Window `0` can refer to a recorded inherited initial checkpoint.

## Recover a missing detail

Use `search` or `transcript` when you already know the phrase or message you need. For a small batch of omitted excerpts use `recover --max-images 0 --max-messages 4 --max-chars 1200`. Add `--window N` for a specific checkpoint. With no window, recovery selects the latest eligible checkpoint written by the selected thread in its active rollout. Use `--max-messages 0` for image candidates only. `--export-images` saves the selected images with WebP previews at quarter scale and at most 1,024 pixels per side by default. Pass a recovered `image_id` to `export-image --id ID --original` for the full-resolution file.

```powershell
& $cli recover @source --max-images 0 --max-messages 4 --max-chars 1200 |
    jq '{status, candidate_count, messages: [.messages[] | {rollout, line, role, text}]}'
```

Check `.status` and candidate counts before reading `.messages`. The comparison reports material absent verbatim from the stored replacement history. A summary can express the same information in different words. If the replacement history is unavailable or rollback or damage limits the comparison, switch to a scoped history read and check the reported boundaries. For malformed records, retry with `--salvage` when needed and report any relevant `damaged_records.count` or `missing_base_rollouts`.

## Inspect saved instructions or token counts

`instructions --window N --role developer --limit 5` lists recorded developer messages from the checkpoint snapshot. Use `--role system` for system messages. Select `--item N --chars 0:240` to read an excerpt by its zero-based `.checkpoint_item` in the full replacement history.

`tokens --window N` reports `.totals` for recorded usage. Use `--by-response` for individual responses and `--by-summary` for encrypted summaries. A summary count comes from its matched compaction response, and `null` means unavailable. Reasoning counts describe whole responses, and summary counts can overlap output totals. Prefer recorded `total_tokens` for overall usage.
