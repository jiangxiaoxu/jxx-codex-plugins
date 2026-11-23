# Chat and rollout records

## Choose the scope

Use `--window N`, `--turn ID`, or `--since TIME --until TIME` to narrow a large history. Time bounds use RFC 3339 with an offset or `Z`, include the start, and exclude the end. Use `--segment NAME_OR_ID --lines START:END` for an inclusive, 1-based range of physical JSONL lines. `read` and `search` can include turns later rolled back.

`--origin current` includes the selected thread's own older segments. Use `--origin inherited` for inherited records and `--origin unknown` for ambiguous legacy records. `lineage` distinguishes a spawn parent from a fork parent. If a result has `timestamp_origin: copied_at`, query its `forked_from_thread_id` to look for the original time.

## Choose what to read

- `transcript --last 6 --max-chars 240` reads the latest chat in recorded order. Add `--phase final`, `commentary`, or `partial` to select assistant messages. `--phase final` matches `.phase == "final_answer"`. Missing phases are excluded. For forward pagination, omit `--last`.
- `search` matches literal text by default. Add `--ignore-case`, `--regex`, or `--before` and `--after` as needed. With `read --ref REF`, a search hit reopens the matching field near the match. Extract text from `read --ref` with `.items[].fields[].text`, including for refs obtained from `transcript`. Use `--chars START:END` for a zero-based, half-open slice.
- `inventory --limit 8` counts record types and returns one `.example.ref` per group. To find other records of that projected type, pass `.example.read_type` when present to `read --type TYPE --metadata-only`. To open text, use `read --ref REF` without `--metadata-only`. When `body_available` is false, skip the body read and use any `input_id` or `output_id` for [tool detail](tools.md).

```powershell
python $cli inventory @source --limit 8 |
    jq -c '.items[] | {kind, item_type, event_type, extension, count, example}'

python $cli transcript @source --last 6 |
    jq -er '.items[-1].ref // empty' |
    python $cli read @source --ref - --max-chars 400 |
    jq -er '[.items[].fields[].text] | join("\n")'
```

## Recorded instructions

Use `read --role system`, `read --role developer`, or `search --role developer "phrase"`. Check `kind` and `item_type` for provenance. `message` is an explicit item, `base_instructions` is the saved session snapshot, and `developer_instructions` is a collaboration-mode setting that can repeat across turns. For instructions inside a checkpoint's replacement history, see [Compaction](compaction.md).
