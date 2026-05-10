$ErrorActionPreference = 'Stop'

$RuntimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpScript = Join-Path -Path $RuntimeDir -ChildPath 'node_repl_mcp.mjs'
& node.exe $McpScript @args
exit $LASTEXITCODE
