@echo off
title HAXORDASH
where opencode >nul 2>nul || echo [hint] opencode not on PATH - one-time fix: run install.cmd in this folder
node "%~dp0server.js"
pause
