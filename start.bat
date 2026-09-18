@echo off
REM Double-click this file to run WinDrop -- it just launches start.ps1 with
REM the right flags so you don't need to know PowerShell exists.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause