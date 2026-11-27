# Find and export attachments

If you already have a message `.ref`, use `attachments --ref REF` with the same source. A `transcript` ref lists the attachments visible on that chat message. A separate tool record needs its own ref. Without a ref, narrow the catalog by role and history range, then use `--media image` or `--media audio`.

Apply the [PowerShell settings for jq pipelines](records.md#jq-quick-start). For catalog filters, run `& $cli attachments --help` or `& $cli images --help`.

```powershell
& $cli attachments @source --media audio --role user --window 2 --limit 8 |
    jq '.items[] | {line, attachment_id, availability, resolved_path}'
```

The catalog lists metadata without reading inline media into stdout. `embedded` denotes inline data. `local` provides a resolved path, whose file may still be missing. `reference` and `unresolved` can identify attachments even when export cannot retrieve their bytes. Lookups and exports use local data.

Pass `.image_id` to `export-image` for images and `.attachment_id` to `export-audio` for audio. Export only if the catalog returned an ID:

```powershell
$imageId = $ref | & $cli attachments @source --ref - --media image --kind inline --limit 1 |
    jq -r '.items[0].image_id // empty'
if ($imageId) {
    & $cli export-image @source --id $imageId --max-resolution 512 |
        jq '{invalid_id_count: (.invalid_id_count // 0), unknown_ids, images: [.images[] | {image_id, thumbnail_file, export_error}]}'
}
```

Use thumbnails for ordinary inspection. For full resolution, add `--original` and read `.images[].original_file` from the receipt. `export-audio` reports `.attachments[].audio_file`, an existing local path or a decoded file. Run either export command with `--help` for options.

Exports write media to files and return JSON receipts. Even on exit 0, check `.invalid_id_count` for rejected inputs, `.unknown_ids` for well-formed IDs that did not resolve, and per-item `.export_error`. For batch export, pipe newline-delimited IDs to `--id -`.
