# Read a recorded tool call

For tool records, `search` matches metadata only. If you remember text from the arguments or result, find candidate records by tool name, turn, window, or time, then open their payloads. Apply the [PowerShell settings for jq pipelines](records.md#jq-quick-start) before running the examples.

## Find by recorded ID

Search for the recorded `call_id` or `item_id`. The search pattern is a substring, so compare the ID fields exactly. A `call_id` can link separate input and output records. An `item_id` can locate a record that already contains one or both IDs, such as a recorded shell execution.

```powershell
$toolId = '<recorded-tool-id>'
& $cli search @source $toolId --role tool |
    jq --arg id $toolId '.items |= map(select(.call_id == $id or .item_id == $id) | {path, line, call_id, item_id, input_id, output_id})'
```

Follow a non-null `next_cursor` with the same query to continue the search. To find another record in the same call, use the matching record's `call_id` when present. Otherwise, look near its source location or by tool name.

## Find by tool name

`read --tool NAME` matches an exact name before pagination. An unnamed return can match the filter when the CLI finds a unique compatible earlier call within its history boundary. If you only know where the tool ran, use `read --role tool --metadata-only` with a scope such as `--turn ID` or `--since TIME`.

```powershell
& $cli read @source --tool exec_command --window current --metadata-only --limit 5 |
    jq '.items |= map({tool_name, path, line, call_id, input_id, output_id})'
```

## Open arguments or results

Use `call_id` to identify related records. Copy the selected `input_id` and `output_id` for the detail commands, using the same `@source` as the lookup. Run the command for the ID you found.

```powershell
& $cli tool-input @source --id '<input_id>'
& $cli tool-output @source --id '<output_id>'
```

Read the payload in `.items[].text`. Tool line ranges select payload text across the record's fields. The same flag on `read` selects physical JSONL lines. A single payload line that exceeds the budget spans multiple pages. Run `& $cli tool-input --help` or `& $cli tool-output --help` for ranges and budgets.

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

The tool cursor carries the ID, lines, and budget. Resume with the same command and source, omitting those three options. If the selected record changed, locate it again and start a new read.

### Find a fragment across pages

Follow `next_cursor` until it is null to check the selected payload range. A phrase can span chunks from the same field, including a page boundary. Join chunks with the same `field_index` in `text_offset` order without adding separators. This example checks one candidate output and prints the matching field names.

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

Use `--pointer` in place of the line view for a typed JSON selection. The empty pointer selects the visible root. Escape `~` as `~0` and `/` as `~1` in keys. Protected fields and embedded media stay hidden. If the value exceeds the budget, select a narrower path. A selected `null` or `false` is valid; use `jq '.value'` without `-e`.

```powershell
& $cli tool-input @source --id '<input_id>' --pointer '/arguments/cmd' | jq '.value'
```
