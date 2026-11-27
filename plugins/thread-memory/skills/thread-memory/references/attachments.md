# Find and export attachments

If you already have a message `.ref`, use `attachments --ref REF` with the same source. A `transcript` ref lists the attachments visible on that chat message. A separate tool record needs its own ref. Without a ref, narrow the catalog by role and history range, then use `--media image` or `--media audio`.

Run `& $cli attachments --help` or `& $cli images --help` for catalog filters.

```powershell
& $cli attachments @source --media audio --role user --window 2 --limit 8 |
    jq '.items[] | {line, attachment_id, availability, resolved_path}'
```

The catalog lists metadata without reading inline media into stdout. `embedded` denotes inline data. `local` provides a resolved path, whose file may still be missing. `reference` and `unresolved` can identify attachments even when export cannot retrieve their bytes. Lookups and exports use local data.

Pass `.image_id` to `export-image` for images and `.attachment_id` to `export-audio` for audio. The image example assumes `$ref` points to a record known to contain an embedded image; if the image is optional, check that an ID was returned before calling `export-image`.

```powershell
$ref | & $cli attachments @source --ref - --media image --kind inline --limit 1 |
    jq -er 'first(.items[].image_id // empty)' |
    & $cli export-image @source --id - --max-resolution 512 |
    jq '{unknown_ids, images: [.images[] | {image_id, thumbnail_file, export_error}]}'

& $cli export-audio @source --id $audioId | jq -er '.attachments[0].audio_file'
```

Image export creates WebP thumbnails with Lanczos resampling and preserves aspect ratio. For an inline image, export also saves the decoded original. Audio export returns an existing local path or decodes embedded audio to a file. Run `& $cli export-image --help` for thumbnail sizing or `& $cli export-audio --help` for audio export options.

Use a thumbnail for ordinary inspection. When full resolution is needed, request the original file.

```powershell
& $cli export-image @source --id $imageId --original | jq -er '.images[0].original_file'
```

Exports write media bytes to files and return JSON with paths and metadata. To export several selected attachments in a pipeline, pass newline-delimited IDs with `--id -`. Check `.unknown_ids` for well-formed IDs that did not resolve, `.invalid_id_count` for rejected inputs, and `.export_error` for individual export failures.
