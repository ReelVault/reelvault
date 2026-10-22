# ReelVault Server

[![CI](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml/badge.svg)](https://github.com/ReelVault/reelvault/actions/workflows/ci.yml)

**ReelVault is a self-hosted media server.** Point it at your folders of movies and TV shows, and it builds a library you can browse and stream to any browser, phone or TV on your network. Posters, descriptions, subtitles and resume come with it.
- **Plays what it can, converts only what it must.** Files your device understands stream untouched. Everything else is converted on the fly, on the GPU when one is available.
- **Made for a household.** Each account has profiles with their own progress, watchlist and preferences. Profiles can be locked with a PIN.
- **Extensible.** Metadata, subtitles, media requests, webhooks and more come from plugins. Install them from the admin panel, with no restart.

📖 **Docs:** [reelvault.org](https://reelvault.org) · **Version:** 1.3.0

## Install

Docker is the easiest way. Run these commands in a folder of your choice:

```bash
mkdir reelvault && cd reelvault
curl -fsSLO https://raw.githubusercontent.com/ReelVault/installer/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:3030** and create your administrator account. To add your movies and shows, follow [Adding your media](https://reelvault.org/guide/libraries).

Without Docker, use an installer. It downloads the latest release and sets up ffmpeg for you.

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/ReelVault/installer/main/install/install.ps1 | iex
```

```bash
# Linux
curl -fsSL https://raw.githubusercontent.com/ReelVault/installer/main/install/install.sh | bash
```

All options and step-by-step guides are in [Install & run](https://reelvault.org/guide/getting-started).

## Run from source

For developers. You need [Bun](https://bun.sh) 1.4.4 or newer, plus `ffmpeg` and `ffprobe` on your `PATH`.

```bash
git clone https://github.com/ReelVault/reelvault.git
cd reelvault
bun install
bun dev        # API on http://localhost:3030
```

This runs the API only. The web app lives in [ReelVault/website](https://github.com/ReelVault/website). To serve it from the same port, set `APP_WEB_DIST` to its production build.

Without a `.env` file, the server uses port 3030, keeps its data in `./data` and generates its secrets on first start. Copy `.env.example` to `.env` to change anything.

## Configuration

Most settings live in the admin panel. These environment variables matter most:

| Variable              | Default     | What it does                                                     |
| --------------------- | ----------- | ---------------------------------------------------------------- |
| `APP_PORT`            | `3030`      | HTTP port                                                        |
| `APP_HOST`            | `127.0.0.1` | Set to `0.0.0.0` to reach the server from other devices          |
| `ROOT_DIR`            | `./data`    | Database, images, plugins, logs and secrets                      |
| `APP_PUBLIC_URL`      | —           | Public address, used for links and sign-in when you use a domain |
| `SETUP_TOKEN_ENABLED` | `false`     | Require a one-time token for first-run setup                     |

The full list is in the [configuration guide](https://reelvault.org/guide/configuration).

## Plugins

Plugins are installed from **Admin → Plugins → Available**. They run inside the server process, so only install plugins you trust. To write your own, start with the [plugin guide](https://reelvault.org/plugins/getting-started) and the [plugin template](https://github.com/ReelVault/plugin-template).

## Repositories

| Repository                                                      | What it is                                          |
| --------------------------------------------------------------- | --------------------------------------------------- |
| [reelvault](https://github.com/ReelVault/reelvault)             | The server (this repository)                        |
| [website](https://github.com/ReelVault/website)                 | Web and desktop client                              |
| app                                                             | Mobile client, in development                       |
| [sdk](https://github.com/ReelVault/sdk)                         | Typed TypeScript SDK, published as `@reelvault/sdk` |
| [plugins](https://github.com/ReelVault/plugins)                 | Official plugins and their catalog                  |
| [plugin-template](https://github.com/ReelVault/plugin-template) | Starting point for a new plugin                     |
| [installer](https://github.com/ReelVault/installer)             | Installers, Docker setup and release bundles        |
| [reelvault.org](https://github.com/ReelVault/reelvault.org)     | Documentation site                                  |

## Development

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
