@echo off
setlocal

set "RUNTIME_DIR=%~dp0"
set "MCP_NODE=%NODE_REPL_NODE_PATH%"

if defined MCP_NODE goto run
where node.exe >nul 2>nul
if not errorlevel 1 set "MCP_NODE=node"
if defined MCP_NODE goto run

echo Node executable not found. Install node on PATH or set NODE_REPL_NODE_PATH. 1>&2
exit /b 1

:run
"%MCP_NODE%" "%RUNTIME_DIR%node_repl_mcp.mjs" %*
exit /b %ERRORLEVEL%
