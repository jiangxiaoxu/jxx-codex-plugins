# Chat and rollout records

## Choose the scope

Use `--window N`, `--turn ID`, or a time range to narrow a large history. For scope filters and value formats, run `& $cli search --help` or the help for the command you are using. `read` and `search` can include turns later rolled back.

`--origin current` includes the selected thread's own older segments. Use `--origin inherited` for inherited records and `--origin unknown` for ambiguous legacy records. `lineage` distinguishes a spawn parent from a fork parent. If a result has `timestamp_origin: copied_at`, query its `forked_from_thread_id` to look for the original time.

## Choose what to read

- `transcript --last 6 --max-chars 240` reads the latest chat in recorded order. When filtering by phase, `--phase final` matches `.phase == "final_answer"`. Messages with missing phases are excluded.
- `inventory --limit 8` counts record types and returns one `.example.ref` per group. To find other records of that projected type, pass `.example.read_type` when present to `read --type TYPE --metadata-only`. To open text, use `read --ref REF` without `--metadata-only`. When `body_available` is false, skip the body read and use any `input_id` or `output_id` for [tool detail](tools.md).

```powershell
& $cli inventory @source --limit 8 |
    jq -c '.items[] | {kind, item_type, event_type, extension, count, example}'
```

## Read more of one record

Use the same source and pass a `ref` from `search` or JSON `transcript` to `read --ref`. The text is in `.items[].fields[].text`; `path` and `line` locate the source. The default cap is 1,000 characters with a ref, 400 for `search` or plain `read`. Raise `--max-chars` for a longer excerpt, and `--budget-chars` if it would cap the request.

For a search ref, `text_truncated` means the automatic excerpt omitted part of the matching field, before or after the excerpt. Use `--chars START:END` for a zero-based slice with the end excluded. For a requested slice (including a range saved in a field ref), `text_truncated` only reports a budget cut, not that the slice is partial.

```powershell
$PSNativeCommandUseErrorActionPreference = $true
$ErrorActionPreference = 'Stop'
$messageRef = & $cli transcript @source --last 1 |
    jq -r '.items[0].ref // empty'
if ($messageRef) {
    $messageRef | & $cli read @source --ref - |
        jq '.items[0] | {path, line, fields, text_truncated}'
}
```

## Recorded instructions

Use `read --role system`, `read --role developer`, or `search --role developer "phrase"`. Check `kind` and `item_type` for provenance. `message` is an explicit item, `base_instructions` is the saved session snapshot, and `developer_instructions` is a collaboration-mode setting that can repeat across turns. For instructions inside a checkpoint's replacement history, see [Compaction](compaction.md).
