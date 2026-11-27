# Chat and rollout records

## jq quick start

Set the source and error preferences in each PowerShell 7.4+ invocation that runs a CLI pipeline. Check CLI failures in JSON `.error` on stderr.

```powershell
$source = @() # Current thread; replace with @('--thread', $thread) or @('--rollout', $path) if needed.
$PSNativeCommandUseErrorActionPreference = $true
$ErrorActionPreference = 'Stop'
& $cli search @source 'phrase' --limit 5 |
    jq -c '{items: [.items[] | {path, line, text, ref}], next_cursor}
        + (if has("missing_base_rollouts") then {missing_base_rollouts} else {} end)
        + (if has("damaged_records") then {damaged_record_count: .damaged_records.count} else {} end)'
```

A missing segment or damaged-record count means a zero-hit result may be incomplete. Pass a non-null `next_cursor` to `--cursor` with the same source and query.

## Choose the scope

Use `--window N`, `--turn ID`, or a time range to narrow a large history. For scope filters and value formats, run `& $cli search --help` or the help for the command you are using.

`search`, `read`, and `transcript` can include turns later rolled back. `--origin current` selects the thread's own records, including older segments, not the chat visible after rollback. Use `--origin inherited` for inherited records and `--origin unknown` for ambiguous legacy records. `lineage` distinguishes a spawn parent from a fork parent. If a result has `timestamp_origin: copied_at`, query its `forked_from_thread_id` to look for the original time.

## Choose what to read

- `transcript --last 6 --max-chars 240` returns the latest matching messages (at most six) within the text budget, in rollout order. Omit `--last` for forward pagination. `--phase final` matches `.phase == "final_answer"`; messages without a phase are excluded.
- `search --before N` and `--after N` measure physical JSONL line distance within the same segment. Context excerpts appear in `.context[].fields[].text`, not in `.items`.
- `inventory --limit 8` counts record types and returns one `.example.ref` per group. For `read --type` or `search --type`, use the group's `kind`, `event_type`, or `.example.read_type` when present. Add `--metadata-only` to `read --type TYPE` to list metadata; use `read --ref REF` to open text. When `body_available` is false, use any `input_id` or `output_id` for [tool detail](tools.md).

```powershell
& $cli inventory @source --limit 8 |
    jq -c '.items[] | {kind, item_type, event_type, extension, count, example}'
```

## Read more of one record

Use the same source and pass a `ref` from `search` or JSON `transcript` to `read --ref`. The text is in `.items[].fields[].text`; `path` and `line` locate the source. The default cap is 1,000 characters with a ref, 400 for `search` or plain `read`. Raise `--max-chars` for a longer excerpt, and `--budget-chars` if it would cap the request.

For a search ref, `text_truncated` means the automatic excerpt omitted part of the matching field, before or after the excerpt. Use `--chars START:END` for a zero-based slice with the end excluded. For a requested slice (including a range saved in a field ref), `text_truncated` only reports a budget cut, not that the slice is partial.

```powershell
$messageRef = & $cli transcript @source --last 1 |
    jq -r '.items[0].ref // empty'
if ($messageRef) {
    $messageRef | & $cli read @source --ref - |
        jq '.items[0] | {path, line, fields, text_truncated}'
}
```

## Recorded instructions

Use `read --role system`, `read --role developer`, or `search --role developer "phrase"`. Check `kind` and `item_type` for provenance. `message` is an explicit item, `base_instructions` is the saved session snapshot, and `developer_instructions` is a collaboration-mode setting that can repeat across turns. For instructions inside a checkpoint's replacement history, see [Compaction](compaction.md).
