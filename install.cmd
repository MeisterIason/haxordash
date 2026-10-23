@echo off
setlocal EnableExtensions
title HAXORDASH - setup
echo.
echo   #################################
echo   #     HAXORDASH setup 1.0.2     #
echo   #################################
echo.

rem ---- node ------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo   [ok] node %NODEV%
node -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>nul
if errorlevel 1 goto oldnode

rem ---- opencode CLI (the engine this dashboard drives) ------------------------
where opencode >nul 2>nul
if errorlevel 1 goto nooc
echo   [ok] opencode already installed
goto ocver

:nooc
echo   [ ] opencode CLI not found - npm install -g @opencode/cli@latest ...
call npm install -g @opencode/cli@latest
if errorlevel 1 goto noocfail
echo   [ok] opencode installed

:ocver
opencode --version 2>nul
echo.
echo   [ok] setup complete.
echo        next:    start.cmd   dashboard at http://127.0.0.1:3969
echo        first:   launch opencode once so its shared background service is up
if /i "%~1"=="--no-pause" exit /b 0
pause
exit /b 0

:nonode
echo   [x] Node.js not found - install Node 20+ from https://nodejs.org then rerun.
goto fail
:oldnode
echo   [x] Node 20+ required, found %NODEV% - upgrade then rerun.
goto fail
:noocfail
echo   [x] npm install failed - run manually: npm install -g @opencode/cli@latest
goto fail
:fail
echo.
if /i "%~1"=="--no-pause" exit /b 1
pause
exit /b 1
