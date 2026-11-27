# Inspect and edit thread notes

## Read part of a thread note

Capture the Markdown from `memory read` in PowerShell and print only what you need. This example lists titles and UTF-8 byte counts for sections from a plain `##` heading to the next `##` or `#` heading. Set `$level` to `1` to list `#` sections. Use the `$cli` path from the [Skill](../SKILL.md).

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

The scan counts bytes in the captured, LF-joined text. To estimate the full note size before saving, use `[Text.Encoding]::UTF8.GetByteCount($note)`. The save receipt reports the exact size after writing. The pattern also splits at heading-like lines inside code fences, so use the line filters for those notes.

Use one of these expressions in place of the `foreach` block to print a named section, literal matches with line numbers, or lines 10 through 20.

```powershell
$sections | Where-Object { $_.Groups['title'].Value -eq 'Progress' } |
    Select-Object -First 1 -ExpandProperty Value
$noteLines | Select-String -SimpleMatch 'checkpoint_ready' | Select-Object LineNumber, Line
$noteLines | Select-Object -Skip 9 -First 11
```

For a local edit, keep the full note in `$note` and review only the relevant lines. Apply the edit to `$note`, then send the complete Markdown to `memory write`. See the [Skill's edit example](../SKILL.md#maintain-the-markdown-note). For compaction recovery, read the full note.
