# Synchronous Thread Memory Hook probe

This Windows x64 test project exercises the existing Thread Memory Hook logic through `mcp_tool` over MCP stdio. The bundled plugin continues to use asynchronous command hooks. The probe and its configuration samples are outside the plugin package.

Build the probe with the .NET 10 SDK from the repository root. The verifier uses a temporary Codex home and compares the probe with the packaged command Hook.

```powershell
$probe = 'test-reference/thread-memory/mcp-hook-probe'
$build = Join-Path $env:TEMP ('thread-memory-mcp-probe-' + [guid]::NewGuid())
$publish = Join-Path $build 'publish'
dotnet publish "$probe/thread-memory-mcp-hook-probe.csproj" -c Release -r win-x64 --artifacts-path $build -o $publish
$status = $LASTEXITCODE
if ($status -ne 0) { throw "Native AOT publish failed ($status)" }
dotnet run --file "$probe/verify-probe.cs" -- "$publish/Thread-Memory-Mcp-Hook-Probe.exe" "plugins/thread-memory/bin/Thread-Memory-Hook.exe"
```

To exercise Codex dispatch, use a separate temporary `CODEX_HOME` and copy the desired event entries from [hooks.example.json](hooks.example.json) to its `hooks.json`. Add [config.example.toml](config.example.toml) to its `config.toml` with absolute paths to the probe and that same temporary home. Trust the selected handlers in the test instance. The sample requires MCP startup so that the server is ready for the first turn. Register one handler per event being compared.

- `SessionStart` produces main-thread startup and compaction guidance. A fork performs the existing note check silently.
- `SubagentStart` produces the child's maintenance guidance.
- `PostCompact` records a child's pending recovery. The command `PostToolUse` still delivers it on a later callback. The verifier runs that callback as well.

For a synchronous command comparison, use the packaged Hook executable at an absolute path and set `async: false` on the selected test handler. Retain the asynchronous command `PostToolUse` when testing delivery on a later callback.
