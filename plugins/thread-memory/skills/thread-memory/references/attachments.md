# Find and export attachments

If you already have a message `.ref`, use `attachments --ref REF` with the same source. A `transcript` ref lists the attachments visible on that chat message. A separate tool record needs its own ref. Without a ref, narrow the catalog by role and history range, then use `--media image` or `--media audio`.

```powershell
python $cli attachments @source --media audio --role user --window 2 --limit 8 |
    jq '.items[] | {line, attachment_id, availability, resolved_path}'
```

The catalog lists metadata without reading inline media into stdout. `embedded` denotes inline data. `local` provides a resolved path, whose file may still be missing. `reference` and `unresolved` can identify attachments even when export cannot retrieve their bytes. Lookups and exports use local data.

Pass `.image_id` to `export-image` for images and `.attachment_id` to `export-audio` for audio. When chaining from a piped ref, let `attachments` consume the ref and let the export command consume the selected ID. This example exports a single embedded image.

```powershell
$ref | python $cli attachments @source --ref - --media image --kind inline --limit 1 |
    jq -er 'first(.items[].image_id // empty)' |
    python $cli export-image @source --id - --max-resolution 512 |
    jq '{unknown_ids, images: [.images[] | {image_id, thumbnail_file, export_error}]}'

python $cli export-audio @source --id $audioId | jq -er '.attachments[0].audio_file'
```

Image export uses Pillow with WebP support. Thumbnails preserve aspect ratio and cap both dimensions. For an inline image, export also saves the decoded original. Audio export returns an existing local path or decodes embedded audio to a file. Use `--output-dir DIR` to choose where new files are written.

To export several selected attachments, repeat `--id` or pass newline-delimited IDs with `--id -`. Inspect `.unknown_ids` and each result's `.export_error`, since successful and failed items can appear together.
