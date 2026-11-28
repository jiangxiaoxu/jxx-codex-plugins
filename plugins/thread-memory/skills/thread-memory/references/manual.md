# Thread Memory user manual

[PowerShell setup](#powershell-setup) | [Notes](#read-part-of-a-thread-note) | [Chat and records](#chat-and-rollout-records) | [Tool calls](#tool-calls-and-payloads) | [Attachments](#find-and-export-attachments) | [Compaction and usage](#compaction-and-usage)

## PowerShell setup

Use PowerShell 7.4 or later and set `$cli` to the full path of `bin/Thread-Memory.exe` in the plugin directory. The CLI works on its own. The pipelines below use `jq` to keep relevant fields. Set the source and error preferences before running them, and inspect JSON `.error` on stderr if a rollout command fails.

```powershell
$source = @() # Current thread. Use @('--thread', $thread) or @('--rollout', $path) to select another source.
$PSNativeCommandUseErrorActionPreference = $true
$ErrorActionPreference = 'Stop'
```

## Read part of a thread note

Capture `memory read` into `$noteLines` to inspect a section or count bytes. The example lists plain `##` sections and counts UTF-8 bytes in the LF-joined text. Set `$level` to `1` for `#` sections. The pattern also splits at heading-like lines in code fences, so use line filters for those notes.

```powershell
$noteLines = @(& $cli memory read)
$readExit = $LASTEXITCODE
if ($readExit -eq 0) {
    $level = 2
    $note = $noteLines -join "`n"
    $sections = [regex]::Matches($note, "(?ms)^#{$level}[ \t]+(?<title>[^\r\n]+?)(?:[ \t]+#+)?[ \t]*$.*?(?=^#{1,$level}(?:[ \t]|$)|\z)")
    foreach ($section in $sections) {
        [pscustomobject]@{
            Title = $section.Groups['title'].Value
            Bytes = [Text.Encoding]::UTF8.GetByteCount($section.Value)
        }
    }
} else {
    Write-Error "memory read failed ($readExit)" -ErrorAction Continue
}
```

After a successful read, use one of these expressions for a named section, literal matches with line numbers, or lines 10 through 20. For edits, keep the full note in `$note` and pipe the complete updated Markdown to `memory write`.

```powershell
$sections | Where-Object { $_.Groups['title'].Value -eq 'Progress' } |
    Select-Object -First 1 -ExpandProperty Value
$noteLines | Select-String -SimpleMatch 'checkpoint_ready' | Select-Object LineNumber, Line
$noteLines | Select-Object -Skip 9 -First 11
```

## Chat and rollout records

Use `transcript --last 6 --max-chars 240` for recent chat. It returns up to six latest matching messages within the text budget, in rollout order. Omit `--last` for forward pagination. `--phase final` matches `.phase == "final_answer"`.

Use `search` for readable rollout fields and tool metadata. Multiple rollout records can yield hits for one chat message. Keep the cursor and diagnostics when filtering a page with `jq`.

```powershell
& $cli search @source 'phrase' --limit 5 |
    jq -c '{items: [.items[] | {path, line, text, ref, text_truncated}], next_cursor}
        + (if has("missing_base_rollouts") then {missing_base_rollouts} else {} end)
        + (if has("damaged_records") then {damaged_record_count: .damaged_records.count} else {} end)'
```

A missing segment or damaged-record count means a zero-hit result may be incomplete. To see nearby records, `search --before N` and `--after N` count physical JSONL lines within the same segment. Text from those records is in `.context[].fields[].text`.

### Scope and page results

`search --limit N` and `read --limit N` start with up to N matches in rollout order. Use `--since TIME` for records at or after an ISO 8601 timestamp with a time zone, `--window current` for the open window, `--window N` for a numbered checkpoint window, or `--turn ID` for one turn. Pass a non-null `next_cursor` to `--cursor` with the same source and query.

`search`, `read`, and `transcript` can include rolled-back turns. `--origin current` selects the thread's own records across windows. Use `--origin inherited` for inherited records or `--origin unknown` for ambiguous legacy records. `lineage` distinguishes a spawn parent from a fork parent. If `timestamp_origin` is `copied_at`, query `forked_from_thread_id` for the original time.

### Discover record types

`inventory --limit 8` counts record types and returns one `.example.ref` per group. For `read --type` or `search --type`, use the group's `kind`, `event_type`, or `.example.read_type` when present. Add `--metadata-only` to `read --type TYPE` to list metadata. For tools with `body_available: false`, open the available `input_id` or `output_id`.

```powershell
& $cli inventory @source --limit 8 |
    jq -c '.items |= map({kind, item_type, event_type, extension, role, count, example})'
```

### Read more of one record

Pass a `ref` from `search` or JSON `transcript` to `read --ref` with the same source. The text is in `.items[].fields[].text`. Use `path` and `line` to locate the source. The excerpt cap defaults to 1,000 characters with a ref and 400 for `search` or plain `read`. Raise `--max-chars` and, if needed, `--budget-chars` to read more.

For a search ref, `text_truncated` means the automatic excerpt omitted part of the matching field. Use `--chars START:END` for a zero-based slice with the end excluded. On an explicit or saved slice, `text_truncated` means the budget cut the requested range.

```powershell
$messageRef = & $cli transcript @source --last 1 |
    jq -r '.items[0].ref // empty'
if ($messageRef) {
    $messageRef | & $cli read @source --ref - |
        jq '.items[0] | {path, line, fields, text_truncated}'
}
```

### Recorded instructions

Use `read --role system`, `read --role developer`, or `search --role developer "phrase"`. Check `kind` and `item_type` for provenance. `message` is an explicit item, `base_instructions` is the saved session snapshot, and `developer_instructions` is a collaboration-mode setting that can repeat across turns. See [compaction and usage](#compaction-and-usage) for instructions inside a checkpoint.

## Tool calls and payloads

For tool records, `search` matches metadata only. To check text from arguments or results, find candidate records, then open their payloads.

### Find by recorded ID

Search for a recorded `call_id` or `item_id`. The pattern is a substring, so compare the ID fields exactly. A `call_id` can link separate input and output records. An `item_id` can locate a record containing one or both detail IDs.

```powershell
$toolId = '<recorded-tool-id>'
& $cli search @source $toolId --role tool |
    jq --arg id $toolId '.items |= map(select(.call_id == $id or .item_id == $id) | {path, line, call_id, item_id, input_id, output_id})'
```

Use `next_cursor` for more matches. To find related records, use the matching record's `call_id` when present. Otherwise, look near its source location or by tool name.

### Find by tool name or scope

`read --tool NAME` matches an exact name before pagination. An unnamed return can match when the CLI finds a unique compatible earlier call within the same history boundary. If the name is unknown, use `read --role tool --metadata-only` with a window, turn, or time bound.

```powershell
& $cli read @source --tool exec_command --window current --metadata-only --limit 5 |
    jq '.items |= map({tool_name, path, line, call_id, input_id, output_id})'
```

### Open arguments or results

Copy the selected `input_id` or `output_id` and use the same `@source` as the lookup.

```powershell
& $cli tool-input @source --id '<input_id>'
& $cli tool-output @source --id '<output_id>'
```

Read the payload in `.items[].text`. On detail commands, `--lines` selects payload lines across the record's fields. On `read`, it selects physical JSONL lines. A single payload line can span pages when it exceeds the budget. The detail cursor carries the ID, lines, and budget. Resume with the same command and source and pass only the cursor as a selector. If the selected record changed, locate it again and start a fresh read.

```powershell
$outputId = '<output_id>'
$page = & $cli tool-output @source --id $outputId --lines 10:20 --budget-chars 1500
$page | jq -c '.items |= map({field, text_offset, text})'
$cursor = $page | jq -r '.next_cursor // empty'
if ($cursor) {
    $cursor | & $cli tool-output @source --cursor - |
        jq -c '.items |= map({field, text_offset, text})'
}
```

### Find a fragment across pages

Follow `next_cursor` until it is null. A phrase can span chunks from the same field, including a page boundary. Join chunks with the same `field_index` in `text_offset` order without adding separators. This example checks one candidate output and prints the matching field names.

```powershell
$outputId = '<output_id>'
$fragment = '<literal text from the result>'
& {
    $page = & $cli tool-output @source --id $outputId
    while ($true) {
        $page
        $cursor = $page | jq -r '.next_cursor // empty'
        if (-not $cursor) { break }
        $page = $cursor | & $cli tool-output @source --cursor -
    }
} | jq -sr --arg fragment $fragment '
    [.[].items[]] | group_by(.field_index)[] |
    select(sort_by(.text_offset) | map(.text) | join("") | contains($fragment)) |
    .[0].field'
```

### Read a structured value

Use `--pointer` for a typed JSON selection. The empty pointer selects the visible root. Escape `~` as `~0` and `/` as `~1` in keys. Protected fields and embedded media stay hidden. If the value exceeds the budget, select a narrower path. A selected `null` or `false` is valid. Read `.value` without `jq -e` to preserve these results.

```powershell
& $cli tool-input @source --id '<input_id>' --pointer '/arguments/cmd' | jq '.value'
```

## Find and export attachments

Use `attachments --ref REF` if you have a message ref. A `transcript` ref lists attachments visible on that chat message. A separate tool record needs its own ref. Without one, narrow by role, history range, and `--media image` or `--media audio`. Use the same source for the ref and any export IDs.

```powershell
& $cli attachments @source --media audio --role user --window 2 --limit 8 |
    jq -c '.items |= map({line, attachment_id, availability, resolved_path})'
```

Catalog results contain metadata. `embedded` identifies inline data. `local` provides a resolved path whose file may be missing. `reference` and `unresolved` can identify attachments whose bytes are unavailable to export. Lookups and exports use local data.

Pass `.image_id` to `export-image` and `.attachment_id` to `export-audio`. Read `.images[].thumbnail_file` for a preview or add `--original` and read `.images[].original_file` for full resolution. Audio receipts report `.attachments[].audio_file`, an existing local path or a decoded file.

```powershell
$ref = '<message-ref>'
$imageId = $ref | & $cli attachments @source --ref - --media image --kind inline --limit 1 |
    jq -r '.items[0].image_id // empty'
if ($imageId) {
    & $cli export-image @source --id $imageId --max-resolution 512 |
        jq '{invalid_id_count: (.invalid_id_count // 0), unknown_ids, images: [.images[] | {image_id, thumbnail_file, export_error}]}'
}
```

Check `.invalid_id_count`, `.unknown_ids`, and per-item `.export_error` in the receipt even when the command exits successfully. For batch export, pipe newline-delimited IDs to `--id -`.

## Compaction and usage

`inspect` lists recent checkpoints. Use `windows --limit 8` for a paged list with `window`, `first_at`, `last_at`, and `compacted_at`. Pass a numbered window to `recover` or `instructions`. Window `0` can refer to an inherited initial checkpoint. The open window follows the latest checkpoint and has `compacted_at: null`. Time ranges on `windows` match overlapping windows.

### Recover a missing detail

Use `search` or `transcript` if you know the phrase or message. Use `recover` for a small batch of excerpts that the checkpoint did not carry forward verbatim. A summary can express the omitted text in different words. Without `--window`, recovery uses the latest eligible checkpoint written by the selected thread in its active rollout. Pass a recovered `image_id` to `export-image --id ID --original` for full resolution.

```powershell
& $cli recover @source --max-images 0 --max-messages 4 --max-chars 1200 |
    jq '{
        status, candidate_count, history_ignored_through_rollback, history_ignored_through_gap,
        missing_base_rollouts, damaged_record_count: .damaged_records.count,
        messages: [.messages[] | {rollout, line, role, text}]
    } | with_entries(select(.value != null))'
```

Check `.status`, candidate counts, and reported boundaries or gaps before reading `.messages`. If the replacement history is unavailable or incomplete, switch to a scoped history read. For malformed records, retry with `--salvage` and check `damaged_record_count`.

### Inspect saved instructions or token counts

`instructions --window N --role developer --limit 5` lists developer messages from a checkpoint snapshot. Use `--item N --chars 0:240` to read an excerpt by `.checkpoint_item` in the full replacement history.

`tokens --window N` reports `.totals` for recorded usage. Use `--by-response` or `--by-summary` for details. A summary count comes from its matched compaction response. `null` means unavailable. Reasoning counts describe whole responses, and summary counts can overlap output totals. Prefer recorded `total_tokens` for overall usage.
