#!/usr/bin/env bash
# ReelVault launcher (Linux/macOS) — part of the release archive.
# Keeps all state inside the archive folder by default:
#   ./data  (database, secrets, images, logs)   ./web  (web UI)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional overrides written by the installer (APP_HOST, APP_PORT, …):
if [ -f "$HERE/settings.env" ]; then
	. "$HERE/settings.env"
fi

# A static ffmpeg/ffprobe pair dropped into ./bin (installer fallback) wins.
if [ -d "$HERE/bin" ]; then
	PATH="$HERE/bin:$PATH"
	export PATH
fi

# Point the server at the bundled pair unless the caller already chose one.
# A path saved in the admin UI still takes precedence (see server.config.ts).
if [ -z "${APP_FFMPEG_PATH:-}" ] && [ -x "$HERE/bin/ffmpeg" ]; then
	export APP_FFMPEG_PATH="$HERE/bin/ffmpeg"
fi
if [ -z "${APP_FFPROBE_PATH:-}" ] && [ -x "$HERE/bin/ffprobe" ]; then
	export APP_FFPROBE_PATH="$HERE/bin/ffprobe"
fi

export ROOT_DIR="${ROOT_DIR:-$HERE/data}"
export APP_WEB_DIST="${APP_WEB_DIST:-$HERE/web}"
export APP_HOST="${APP_HOST:-127.0.0.1}"
export APP_PORT="${APP_PORT:-3030}"

mkdir -p "$ROOT_DIR"

exec "$HERE/bun/bun" run "$HERE/server/src/index.ts"
