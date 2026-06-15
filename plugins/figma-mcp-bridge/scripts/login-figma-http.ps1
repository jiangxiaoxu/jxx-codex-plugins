Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverName = "figma-http"
$serverUrl = "http://127.0.0.1:18766/mcp"
$metadataUrl = "http://127.0.0.1:18766/.well-known/oauth-protected-resource"

function Quote-Arg {
  param([string]$Value)

  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  return '"' + ($Value -replace '"', '\"') + '"'
}

function Resolve-OAuthCachePath {
  if ($env:FIGMA_MCP_OAUTH_CACHE_PATH) {
    return $env:FIGMA_MCP_OAUTH_CACHE_PATH
  }

  if ($env:CODEX_HOME) {
    return (Join-Path $env:CODEX_HOME ".figma-mcp-bridge-oauth.json")
  }

  if ($env:USERPROFILE) {
    return (Join-Path (Join-Path $env:USERPROFILE ".codex") ".figma-mcp-bridge-oauth.json")
  }

  return $null
}

function Test-BridgeReady {
  try {
    $response = Invoke-WebRequest -Uri $metadataUrl -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  }
  catch {
    return $false
  }
}

function Start-Bridge {
  if (Test-BridgeReady) {
    Write-Host "Bridge already reachable at $metadataUrl"
    return $null
  }

  $pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  Write-Host "Starting local bridge from $pluginRoot"

  $process = Start-Process `
    -FilePath "node" `
    -ArgumentList @("scripts/server.mjs") `
    -WorkingDirectory $pluginRoot `
    -WindowStyle Hidden `
    -PassThru

  for ($i = 0; $i -lt 30; $i++) {
    if ($process.HasExited) {
      throw "Figma MCP bridge exited early with code $($process.ExitCode)."
    }

    if (Test-BridgeReady) {
      Write-Host "Bridge ready at $metadataUrl"
      return $process
    }

    Start-Sleep -Milliseconds 500
  }

  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  throw "Figma MCP bridge did not become ready at $metadataUrl."
}

if ($env:FIGMA_MCP_BRIDGE_LOGIN_CHILD -ne "1") {
  $hostExe = (Get-Command "pwsh" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
  if (-not $hostExe) {
    $hostExe = (Get-Command "powershell" -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source)
  }

  $escapedPath = $PSCommandPath -replace "'", "''"
  $launchCommand = '$env:FIGMA_MCP_BRIDGE_LOGIN_CHILD = "1"; & ''' + $escapedPath + ''''
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchCommand))
  $childArgs = @(
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    $encodedCommand
  )

  Start-Process -FilePath $hostExe -ArgumentList (($childArgs | ForEach-Object { Quote-Arg $_ }) -join " ")
  return
}

function Invoke-CodexMcp {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$IgnoreFailure
  )

  Write-Host ""
  Write-Host ("> codex " + ($Arguments -join " "))
  & codex @Arguments
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0 -and -not $IgnoreFailure) {
    throw "codex exited with code $exitCode"
  }

  return $exitCode
}

$resolvedCachePath = Resolve-OAuthCachePath

Write-Host "Figma MCP login"
Write-Host "Server name: $serverName"
Write-Host "Server URL:  $serverUrl"
Write-Host "CODEX_HOME:  $env:CODEX_HOME"
Write-Host "USERPROFILE: $env:USERPROFILE"
Write-Host "Cache path:  $resolvedCachePath"

$command = Get-Command "codex" -ErrorAction SilentlyContinue
if (-not $command) {
  throw "Cannot find 'codex' on PATH."
}

$bridgeProcess = $null
try {
  $bridgeProcess = Start-Bridge
  Invoke-CodexMcp -Arguments @("mcp", "remove", "figma-http") -IgnoreFailure | Out-Null
  Invoke-CodexMcp -Arguments @("mcp", "add", "figma-http", "--url", "http://127.0.0.1:18766/mcp") | Out-Null
  Invoke-CodexMcp -Arguments @("mcp", "login", "figma-http") | Out-Null
}
finally {
  Invoke-CodexMcp -Arguments @("mcp", "remove", "figma-http") -IgnoreFailure | Out-Null
  if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
    Stop-Process -Id $bridgeProcess.Id -Force
  }
}

Write-Host ""
Write-Host "Done. If login completed, the OAuth cache should be available for the bridge and stdio frontend."
