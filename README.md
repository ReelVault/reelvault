# ReelVault Server

[![CI Pipeline](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml/badge.svg)](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml)

Self-hosted media server backend: organizes your movie and TV library, streams it over HLS with on-the-fly transcoding, and extends itself through a runtime plugin system. Pairs with [website](https://github.com/ReelVault/website) (web + desktop client).

## Highlights

- **Streaming** — HLS with per-session transcode pipelines, direct play / remux when the client can handle the file, adaptive transcode progress reporting, seek with real stream-start alignment, trickplay previews.
- **Hardware acceleration** — capability detection with a verification test-encode per encoder, per-frame software fallback, diagnostics panel.
- **HDR** — HDR10 / Dolby Vision / HLG detection, "HDR always transcodes" policy with HDR→SDR tone-mapping (tonemapx / zscale).
- **Library** — scanning with inotify-style watchers, metadata and images from pluggable providers, seasons/episodes, multiple versions per title, sort titles, intro / credits / recap markers.
- **Multi-user** — accounts via better-auth, playback sessions with admin visibility and termination, per-profile audio/subtitle preferences, watched state and filters.
- **Plugins** — first-class SDK: providers (metadata, subtitles), markers, jobs, HTTP routes, storage, artifacts, events, hooks, access policies and UI slots that render in the web client with zero frontend changes. Install from a catalog at runtime — see the [plugin development guide](https://reelvault.org/plugins/getting-started).
- **Operations** — admin settings UI, worker/scheduled-task dashboards, ffmpeg capability diagnostics, live sessions, notifications, rate limiting, audit log, structured rotating logs.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4.2
- **ffmpeg + ffprobe** on `PATH` (mandatory — the server refuses to start without them), or a release archive with the `-full` suffix, which bundles both

## Quickstart

The fastest way is Docker — one container runs the API, the web UI and ffmpeg on a single port:

```bash
docker compose up -d
# open http://localhost:3030 and create the administrator account
```

Installers for Windows (`install.ps1`, wrapper `install.bat`) and Linux (`install.sh`) live in [`install/`](install/) and are meant to be downloaded from there — they resolve the latest [release](https://github.com/ReelVault/reelvault/releases) for you. Release archives ship the runtime and web UI: unpack and run `start.sh` / `start.bat`, or install with `install.sh --full` / `install.ps1 -Full` to get the archive with ffmpeg/ffprobe bundled in `bin/`. Setup needs **no token** by default; enable `SETUP_TOKEN_ENABLED=true` before exposing an unconfigured server to the public internet.

### From source

```bash
git clone https://github.com/ReelVault/reelvault.git
cd reelvault
bun install

cp .env.example .env   # optional — sane defaults apply without it
bun dev                # http://localhost:3030 — API only, no bundled UI
```

Without a `.env` the server uses defaults: port `3030`, data in `./data`, and auto-generated secrets persisted to `data/secrets.env` (created on first boot with `0600` permissions). When setup is pending the log tells you to open the setup wizard (or, with `SETUP_TOKEN_ENABLED=true`, prints the one-time token).

To serve the web UI from the same process, point `APP_WEB_DIST` (or a `./web` folder) at a production build of [website](https://github.com/ReelVault/website).

### Configuration

All settings are optional (see [.env.example](.env.example)); the useful ones:

| Variable | Default | Purpose |
|---|---|---|
| `APP_PORT` | `3030` | HTTP port |
| `APP_HOST` | `127.0.0.1` (prod) | Bind address; `0.0.0.0` for LAN |
| `ROOT_DIR` | `./data` | SQLite DB, transcodes, downloads, plugins, images |
| `APP_WEB_DIST` | `./web` if present | Built web UI served on the same port |
| `APP_FFMPEG_PATH` | `ffmpeg` on `PATH` | ffmpeg binary; a path saved in the admin UI wins |
| `APP_FFPROBE_PATH` | `ffprobe` on `PATH` | ffprobe binary; a path saved in the admin UI wins |
| `SETUP_TOKEN_ENABLED` | `false` | Require a setup token for first-run |
| `SETUP_TOKEN` | generated when enabled | One-time token for creating the first admin |
| `BETTER_AUTH_SECRET` | generated | Session/auth secret — keep it stable across restarts |
| `OPENAPI_DOCS_ENABLED` | `true` | Interactive API reference at `/openapi` |

## Plugin development

ReelVault's plugin SDK is published as [`reelvault-sdk`](https://www.npmjs.com/package/reelvault-sdk) (sources in [`sdk/`](sdk/)). A plugin is a directory with a `plugin.json` manifest and a TypeScript entry — loaded at runtime, no rebuild needed. The full guide (manifest, capabilities, host API, UI slots, publishing to a catalog) lives at [reelvault.org/plugins](https://reelvault.org/plugins/getting-started).

To use the server as a library (SDK/typed client):

```bash
bun run build-sdk   # emits sdk/dist/ (root, client, common, plugin, ui, testing)
```

## Scripts

```bash
bun dev              # watch mode
bun start            # production start
bun test             # test suite
bun run lint         # biome + oxlint
bun run check-types  # tsc --noEmit
bun run deadcode     # knip
bun run db:migrate   # apply migrations (drizzle-kit)
```
