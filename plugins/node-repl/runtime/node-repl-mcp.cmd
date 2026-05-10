@echo off
setlocal

set "RUNTIME_DIR=%~dp0"
set "NODE_EXE=%RUNTIME_DIR%bin\node.exe"
set "NODE_REPL_EXE=%RUNTIME_DIR%bin\node_repl.exe"

if "%NODE_REPL_RUNTIME_REFRESH%"=="1" goto bootstrap
if not exist "%NODE_EXE%" goto bootstrap
if not exist "%NODE_REPL_EXE%" goto bootstrap
goto run_vendored

:bootstrap
set "BOOTSTRAP_NODE=%NODE_REPL_NODE_PATH%"
if not defined BOOTSTRAP_NODE set "BOOTSTRAP_NODE=node"
"%BOOTSTRAP_NODE%" "%RUNTIME_DIR%bootstrap.mjs"
if errorlevel 1 exit /b %ERRORLEVEL%

if exist "%NODE_EXE%" goto run_vendored
if defined NODE_REPL_NODE_PATH goto run_override
echo Vendored node.exe is missing after bootstrap. 1>&2
exit /b 1

:run_vendored
"%NODE_EXE%" "%RUNTIME_DIR%node_repl_mcp.mjs" %*
exit /b %ERRORLEVEL%

:run_override
"%NODE_REPL_NODE_PATH%" "%RUNTIME_DIR%node_repl_mcp.mjs" %*
exit /b %ERRORLEVEL%
