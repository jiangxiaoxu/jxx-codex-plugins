# Codex MCP Apps

Use this guide when a plugin in this marketplace needs a local Desktop view hosted by an MCP server.

## Open a view from the sidebar

1. Register the local stdio server in `mcp.json` at the plugin root. In the Codex compatibility manifest, point `mcpServers` at `./mcp.json`. [Plugin packaging](https://developers.openai.com/plugins/build/plugins#plugin-structure)
2. Register the view at a `ui://` resource URI. Return the HTML from `resources/read` with `text/html;profile=mcp-app` as its MIME type.
3. In `tools/list`, associate the tool with the resource using `_meta.ui.resourceUri` and put a `global` entrypoint in `_meta["openai/ui"].entrypoints`. The tool accepts `{}` when Codex opens the entrypoint. Use `_meta.ui.visibility` set to `["app"]` for app-only tools. [Global entrypoint specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#global-entrypoint)

This `tools/list` item opens an example app-only view.

```json
{
  "name": "open_overview",
  "title": "Overview",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
  "_meta": {
    "ui": { "resourceUri": "ui://example/overview", "visibility": ["app"] },
    "openai/ui": { "entrypoints": [{ "type": "global" }] }
  }
}
```

## Supply icons for each surface

| Surface | Configuration |
| --- | --- |
| Plugin list | Set `interface.logo` in `.codex-plugin/plugin.json` to a bundled square image, for example `./assets/plugin-icon.png`. The path is relative to the plugin root. |
| Sidebar entrypoint | Add `icons` at the top level of the entrypoint's `tools/list` item. For an embedded local PNG, use a `data:image/png;base64,...` URI with `mimeType: "image/png"` and the asset size in `sizes`, for example `["64x64"]`. |

`interface.composerIcon` is the icon for the composer. The sidebar resolves the tool's icon first, then the local MCP server icon, then the generic icon. [Manifest fields](https://developers.openai.com/plugins/deploy/submission#listing-metadata) · [Entrypoint icons](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#entrypoint-icons)

For the narrow Desktop rail, use an opaque glyph on a transparent background so the host can tint its shape as a monochrome mask. Check that the outline and internal spaces remain legible at rail size.

## Verify the package

Check that the manifest's logo path resolves inside the package. A stdio smoke test can check that `tools/list` returns the intended global entrypoint and icon, that the icon decodes to the packaged PNG, and that `resources/read` serves the HTML. Check the listing and sidebar in the target Desktop build with MCP Apps enabled.

Use the official [Bits & Bolts plugin](https://github.com/openai/mcp-extensions/tree/main/plugins/bits-and-bolts) for an entrypoint example and [MCP Apps basics](https://github.com/openai/openai-apps-sdk-examples/tree/main/mcp_app_basics_node) for view-to-tool calls. In this repository, [Thread Memory's Desktop panel](thread-memory.md#desktop-panel) links to the local implementation.
