@echo off
rem agntspce-collab - Collaboration CLI launcher (Windows)
rem Routes to the Node.js implementation in agntspce-collab.mjs.
rem bin\ is on the agent PATH, so this launcher is what makes the command
rem resolvable; without it agents silently skip claim/post/done.
rem
rem The CLI needs node:sqlite (Node >= 22.5), so prefer the system node and
rem only fall back to AGNTSPCE_NODE_PATH (the Electron binary).
setlocal
set "SCRIPT_DIR=%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if defined AGNTSPCE_NODE_PATH set "NODE=%AGNTSPCE_NODE_PATH%"
if not defined NODE (
  echo agntspce-collab: no Node.js found ^(need Node ^>= 22.5 for node:sqlite^) 1>&2
  exit /b 127
)
"%NODE%" "%SCRIPT_DIR%agntspce-collab.mjs" %*
