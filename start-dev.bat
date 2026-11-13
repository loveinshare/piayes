@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ================================================================
rem  piayes local dev  --  backend API (8131) + vite frontend (5173)
rem
rem  NOTE: keep this file pure ASCII.
rem        "chcp 65001" makes cmd re-read the file with the new code
rem        page; any multibyte (Chinese) text after that point gets
rem        sliced at the wrong byte offset and cmd tries to run the
rem        fragments as commands. Chinese diagnostics are printed by
rem        scripts/dev.mjs instead (node handles UTF-8 fine).
rem
rem  Behavior:
rem    - pre-flight checks: node / npm / dependencies, each with a
rem      concrete reason (not a generic "something went wrong")
rem    - on failure: print the real cause and keep the window open
rem      so the message can be read before closing
rem ================================================================

echo Starting piano-follow dev server (frontend + backend API)...
echo   frontend: http://127.0.0.1:5173
echo   backend : http://127.0.0.1:8131  (vite proxies /api here)
echo.

rem ---------- pre-flight 1: node on PATH ----------
where node >nul 2>&1
if errorlevel 1 goto :no_node

rem ---------- pre-flight 2: npm on PATH ----------
where npm >nul 2>&1
if errorlevel 1 goto :no_npm

rem ---------- pre-flight 3: dependencies installed ----------
rem  A half-finished "npm install" (interrupted / no network) is the
rem  most common failure here: vite is missing, but so are react,
rem  zustand and friends - so check before starting anything.
if not exist "node_modules\vite\bin\vite.js" goto :no_deps

rem ---------- go ----------
rem  MUST be "call": npm.cmd is a batch file. Without CALL, cmd hands
rem  control to it and never comes back -- the lines below (the error
rem  message and the final pause) would never run, and the window
rem  would close the moment the dev server stopped.
call npm run dev:all
set "DEV_EXIT=%ERRORLEVEL%"

if "%DEV_EXIT%"=="0" goto :ok

rem Exit code 3 = an existing dev server already owns 5173 + 8131.
rem That is not a failure; just tell the user which URL to open.
if "%DEV_EXIT%"=="3" goto :already

rem Ctrl+C / SIGTERM exit codes are not failures
rem   130 = SIGINT, 143 = SIGTERM, 0xC000013A = Windows control-C
rem   (cmd shows 0xC000013A as the signed form -1073741510)
if "%DEV_EXIT%"=="130" goto :stopped
if "%DEV_EXIT%"=="143" goto :stopped
if "%DEV_EXIT%"=="3221225786" goto :stopped
if "%DEV_EXIT%"=="-1073741510" goto :stopped

echo.
echo [ERROR] Dev server exited with code %DEV_EXIT%.
echo         The real reason is printed above - look for the lines
echo         starting with "[dev]" / "[api]" / "[web]".
echo         Common causes:
echo           - node_modules incomplete   -^>  npm install
echo           - port 5173 / 8131 in use   -^>  close the old process
echo             (netstat -ano ^| findstr 5173)
goto :fail

:no_node
echo.
echo [ERROR] node was not found in PATH.
echo         Install Node.js 20+ from https://nodejs.org/ and
echo         reopen this window.
goto :fail

:already
echo.
echo Dev server is ALREADY RUNNING.
echo   open: http://127.0.0.1:5173
echo   To restart it, close the window that is running it
echo   (or kill the process holding 8131 / 5173), then run this again.
goto :end

:no_npm
echo.
echo [ERROR] npm was not found in PATH.
echo         Node.js is installed but npm is missing or not on PATH.
goto :fail

:no_deps
echo.
echo [ERROR] Dependencies are missing or incomplete.
echo         node_modules\vite\bin\vite.js was not found.
echo         (node_modules may be a half-finished npm install.)
echo         Fix:  npm install
goto :fail

:stopped
echo.
echo Dev server stopped by user.
goto :end

:ok
echo.
echo Dev server stopped normally.
goto :end

:fail
echo.
echo The window stays open so you can read the error above.
echo Press any key to close it...
goto :end

:end
pause >nul
exit /b 0
