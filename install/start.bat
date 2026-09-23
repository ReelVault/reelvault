@echo off
rem ReelVault launcher (Windows) — part of the release archive.
rem Keeps all state inside the archive folder by default:
rem   .\data  (database, secrets, images, logs)   .\web  (web UI)
setlocal

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

rem Optional overrides written by the installer (APP_HOST, APP_PORT, …):
if exist "%HERE%\settings.cmd" call "%HERE%\settings.cmd"

rem A static ffmpeg/ffprobe pair dropped into .\bin (installer fallback) wins.
if exist "%HERE%\bin" set "PATH=%HERE%\bin;%PATH%"

rem Point the server at the bundled pair unless already overridden (the admin UI still wins).
if not defined APP_FFMPEG_PATH if exist "%HERE%\bin\ffmpeg.exe" set "APP_FFMPEG_PATH=%HERE%\bin\ffmpeg.exe"
if not defined APP_FFPROBE_PATH if exist "%HERE%\bin\ffprobe.exe" set "APP_FFPROBE_PATH=%HERE%\bin\ffprobe.exe"

if not defined ROOT_DIR set "ROOT_DIR=%HERE%\data"
if not defined APP_WEB_DIST set "APP_WEB_DIST=%HERE%\web"
if not defined APP_HOST set "APP_HOST=127.0.0.1"
if not defined APP_PORT set "APP_PORT=3030"

if not exist "%ROOT_DIR%" mkdir "%ROOT_DIR%"

"%HERE%\bun\bun.exe" run "%HERE%\server\src\index.ts"
