# Subagent Reasoning Cap

The synchronous `PreToolUse` hook matches `spawn_agent` and `collaborationspawn_agent`. For
`worker` and `explorer` calls where `reasoning_effort` is absent or null, it reads the latest
`thread_settings_applied` event in the local JSONL transcript. It preserves levels up to `high`
and maps `xhigh`, `max`, and `ultra` to `high`. An explicit effort takes precedence. Calls with
unavailable or unrecognized thread settings continue with Codex's normal inheritance. The hook
preserves the tool's other arguments, including `model` and `fork_turns`.

The package targets Windows x64 and runs under PowerShell. The command in `hooks/hooks.json`
uses the plugin's `PLUGIN_ROOT` to find the bundled Native AOT executable. The executable does
not require the .NET runtime to be installed.

## Build And Validate

From the repository root, use the .NET 10 SDK and Visual Studio C++ build tools:

```powershell
$plugin = 'plugins/subagent-reasoning-cap'
$publish = Join-Path (Resolve-Path .) 'tmp/subagent-reasoning-cap'
dotnet publish "$plugin/src/spawn-agent-effort-hook.csproj" -c Release -r win-x64 --artifacts-path $publish -o "$publish/publish"
$publishExit = $LASTEXITCODE
if ($publishExit -ne 0) { throw "Native AOT publish failed: $publishExit" }
Copy-Item "$publish/publish/spawn-agent-effort-hook.exe" "$plugin/bin/"
```

Check that the manifest name matches the marketplace entry and the plugin directory. Exercise
the bundled executable through hook stdin/stdout with a local transcript and confirm that a
missing effort inherits the capped value and an explicit effort passes through. Include
`bin/spawn-agent-effort-hook.exe` when publishing the plugin directory.

After the published plugin is active, remove the equivalent standalone `PreToolUse` handler
from the user `hooks.json` to avoid running both handlers.
