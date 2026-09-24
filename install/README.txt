ReelVault — media server
========================

Start
-----
  Windows:     double-click start.bat
  Linux/macOS: ./start.sh

Then open  http://localhost:3030  and create the administrator account.
That's it — the web UI, the API and ffmpeg-powered streaming all run from
this single folder.

What is where
-------------
  data\    Your server: database, secrets, images, logs. Back this up —
           it holds everything (libraries, watched state, settings).
  web\     The bundled web UI (do not edit).
  server\  The application (do not edit).
  bun\     The bundled runtime (do not edit).
  bin\     Bundled ffmpeg/ffprobe (only in the "-full" archive).

ffmpeg
------
The "-full" archive ships ffmpeg/ffprobe in bin\ — nothing else to install.
The default archive needs ffmpeg/ffprobe on PATH (the installer adds them).

Moving the server: stop it, move this folder, start it again.

Reach it from other devices
---------------------------
By default ReelVault listens on localhost only.

  Windows: create a file settings.cmd next to start.bat containing:
             @echo off
             set "APP_HOST=0.0.0.0"
  Linux:   start with:  APP_HOST=0.0.0.0 ./start.sh
           (the installer's --remote flag does this for you)

Then open the port in your firewall and browse to http://<server-ip>:3030.
Before exposing ReelVault to the public internet, read the remote-access
guide and consider enabling a setup token:
  https://github.com/ReelVault/reelvault#readme
