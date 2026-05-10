$ErrorActionPreference = 'Stop'

$RuntimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpNode = $env:NODE_REPL_NODE_PATH

if ([string]::IsNullOrWhiteSpace($McpNode)) {
    $NodeCommand = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $NodeCommand) {
        $NodeCommand = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue
    }
    if ($null -ne $NodeCommand) {
        $McpNode = $NodeCommand.Source
    }
}

if ([string]::IsNullOrWhiteSpace($McpNode)) {
    Write-Error 'Node executable not found. Install node on PATH or set NODE_REPL_NODE_PATH.'
    exit 1
}

$McpScript = Join-Path -Path $RuntimeDir -ChildPath 'node_repl_mcp.mjs'
& $McpNode $McpScript @args
exit $LASTEXITCODE
