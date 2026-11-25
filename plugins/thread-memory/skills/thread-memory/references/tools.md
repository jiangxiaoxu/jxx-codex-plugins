# Read a recorded tool call

Use `read --tool NAME` to find an exact tool name before pagination. Narrow the history by turn, window, time, or physical line range. If you already know a call ID, use `search "$callId" --role tool` and check `.call_id` for an exact match. For tool records, `read` and `search` expose only metadata and any available `.input_id` and `.output_id`. An unnamed return can match the tool filter when the CLI finds a unique compatible earlier call within its history boundary.

Pass the selected `.input_id` to `tool-input` or `.output_id` to `tool-output`, using the same rollout source. Tool line ranges select payload text across the record's fields. The same flag on `read` selects physical JSONL lines. A single payload line that exceeds the budget spans multiple pages. Run `& $cli tool-input --help` or `& $cli tool-output --help` for ranges and budgets.

```powershell
$page = & $cli tool-output @source --id $outputId --lines 10:20 --budget-chars 1500
$page | jq -r '.items[].text'
$cursor = $page | jq -r '.next_cursor // empty'
if ($cursor) {
    $cursor | & $cli tool-output @source --cursor - | jq -r '.items[].text'
}
```

The tool cursor carries the ID, lines, and budget. Resume with the same command and source, omitting those three options. If the selected record changed, locate it again and start a new read.

Use `--pointer` in place of the line view for a typed JSON selection. The empty pointer selects the visible root. Escape `~` as `~0` and `/` as `~1` in keys. Protected fields and embedded media stay hidden. If the value exceeds the budget, select a narrower path. A selected JSON `null` is valid, so use `jq '.value'` without `-e` when `null` is expected.

```powershell
& $cli tool-input @source --id $inputId --pointer '/arguments/nested' | jq '.value'
```
