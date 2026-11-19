<div align="center">

<img src=".github/assets/banner.png" alt="ReelVault Server" width="1200">

# ReelVault Server

**The engine behind your home media library.**

[![CI](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml/badge.svg)](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ReelVault/reelvault?style=for-the-badge&color=00E676)](https://github.com/ReelVault/reelvault/releases)
[![Docs](https://img.shields.io/badge/docs-reelvault.org-00E676?style=for-the-badge)](https://reelvault.org)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge)](LICENSE)

[Docs](https://reelvault.org) · [Why ReelVault](#why-reelvault) · [Install](#install) · [Plugins](#plugins) · [Development](#development)

</div>

ReelVault is a self-hosted media server. It scans the folders you point it at, builds a library with posters and descriptions, and streams it to a browser, phone or TV on your network. Everything runs on your own hardware.

<div align="center">

<img src="https://reelvault.org/screenshots/dashboard.webp" alt="The ReelVault dashboard" width="850">

</div>

## Why ReelVault

| What you get | How it works |
|---|---|
| 🎬 **A library built from your files** | Point the server at your movie and show folders. It finds the titles, fetches artwork and descriptions, and remembers where you left off in each one. |
| ▶ **Playback without the guesswork** | If your device can play a file as-is, it gets the original file — no re-encoding, no quality loss. Otherwise the server converts it on the fly, using your graphics card when it can. You set the quality limits; the server does the rest. |
| 👨‍👩‍👧 **Profiles for the whole household** | One account, several viewers. Each profile has its own continue-watching list, watchlist and playback settings, and you can lock a profile with a PIN. |
| 🧩 **Plugins for the extras** | Metadata, subtitles, requests, webhooks and notifications are all plugins. Install them from the admin panel and they load right away — no restart, no rebuild. |
| 🛠️ **Build on it** | The web app's own typed API is published as `@reelvault/sdk`. Write your own client, or add the feature you're missing as a plugin. |
| 🔒 **Your data stays with you** | Files, watch history and settings live on your machine. Plugins are the only things that may reach outside services — and you choose which ones to install. |

The full documentation is at [reelvault.org](https://reelvault.org).

## Install

Docker is the easiest way. Run these commands in a folder of your choice:

```bash
mkdir reelvault && cd reelvault
curl -fsSLO https://raw.githubusercontent.com/ReelVault/installer/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:3030** and create your administrator account. To add your movies and shows, follow [Adding your media](https://reelvault.org/guide/libraries).

If you'd rather not use Docker, the installer downloads the latest release and sets up ffmpeg for you.

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ReelVault/installer/main/install/install.ps1 | iex
```

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/ReelVault/installer/main/install/install.sh | bash
```

For all the options and a step-by-step walkthrough, see [Install & run](https://reelvault.org/guide/getting-started).

## Plugins

Install plugins from **Admin → Plugins → Available**. They run inside the server process, so stick to ones you trust. To write your own, start with the [plugin guide](https://reelvault.org/plugins/getting-started) and the [plugin template](https://github.com/ReelVault/plugin-template).

<div align="center">

<img src="https://reelvault.org/screenshots/admin-plugins.png" alt="The plugin manager in the admin panel" width="850">

</div>

## Repositories

| Repository | What it is |
|---|---|
| [reelvault](https://github.com/ReelVault/reelvault) | The server (this repository) |
| [website](https://github.com/ReelVault/website) | Web and desktop client |
| app | Mobile client, in development |
| [sdk](https://github.com/ReelVault/sdk) | Typed TypeScript SDK, published as `@reelvault/sdk` |
| [plugins](https://github.com/ReelVault/plugins) | Official plugins and their catalog |
| [plugin-template](https://github.com/ReelVault/plugin-template) | Starting point for a new plugin |
| [installer](https://github.com/ReelVault/installer) | Installers, Docker setup and release bundles |
| [reelvault.org](https://github.com/ReelVault/reelvault.org) | Documentation site |

## Development

This part is for people working on the server itself.

### Run from source

You need [Bun](https://bun.sh) 1.4.4 or newer, plus `ffmpeg` and `ffprobe` on your `PATH`.

```bash
git clone https://github.com/ReelVault/reelvault.git
cd reelvault
bun install
bun dev        # API on http://localhost:3030
```

This runs the API only. The web app lives in [ReelVault/website](https://github.com/ReelVault/website). To serve it from the same port, set `APP_WEB_DIST` to its production build.

Without a `.env` file, the server uses port 3030, keeps its data in `./data` and generates its secrets on first start. Copy `.env.example` to `.env` to change any of that.

### Configuration

Most settings live in the admin panel. The environment variables you're most likely to need:

| Variable | Default | What it does |
|---|---|---|
| `APP_PORT` | `3030` | HTTP port |
| `APP_HOST` | `127.0.0.1` | Set to `0.0.0.0` to reach the server from other devices |
| `ROOT_DIR` | `./data` | Database, images, plugins, logs and secrets |
| `APP_PUBLIC_URL` | — | Public URL, used for links and sign-in if you use a domain |
| `SETUP_TOKEN_ENABLED` | `false` | Require a one-time token for first-run setup |

The full list is in the [configuration guide](https://reelvault.org/guide/configuration).

### Commands

Run these from the repository root:

```bash
bun run dev               # watch mode
bun run test              # tests, run from the repository root
bun run lint              # every static check: Biome, oxlint, TypeScript, Knip, jscpd, test quality, migrations
bun run db:migrate        # apply database migrations
bun run benchmark         # list the benchmark suites
bunx lefthook install     # git hooks: lint on commit, lint and tests on push
```

Contributions are welcome. Please read [CONTRIBUTING.md](https://github.com/ReelVault/.github/blob/main/CONTRIBUTING.md) first.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
