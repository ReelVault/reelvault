@echo off
rem One-click wrapper: installs/updates ReelVault with default settings.
rem Double-click this file, or run it from a terminal to pass options, e.g.:
rem   install.bat -Remote -Port 8080
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
