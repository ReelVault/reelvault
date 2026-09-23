#!/usr/bin/env bash
# ReelVault installer for Linux.
#
# Downloads the release archive, installs it under your home directory and
# (on systemd distros) registers a user service that starts on login/boot.
#
# Usage:
#   ./install.sh                      # latest release, default settings
#   ./install.sh --remote             # reachable from other devices on the LAN
#   ./install.sh --port 8080          # custom port
#   ./install.sh --dir /srv/reelvault # custom install directory
#   ./install.sh --file ./archive.tar.gz   # install from a local archive
#   ./install.sh --upgrade            # update an existing install (keeps data)
#   ./install.sh --full               # archive with bundled ffmpeg/ffprobe
#   ./install.sh --uninstall          # remove the service and files (--purge deletes data)
#
# The web UI and API are served on one port (default 3030):
#   http://localhost:3030
set -euo pipefail

REPO="ReelVault/ReelVault.Server"
DEFAULT_DIR="${HOME}/.local/share/reelvault"
VERSION=""
ARCHIVE_FILE=""
TARGET_DIR=""
PORT="3030"
REMOTE="false"
NO_SERVICE="false"
UNINSTALL="false"
PURGE="false"
UPGRADE="false"
FULL="false"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
	case "$1" in
		--version) VERSION="${2:?}"; shift 2 ;;
		--dir) TARGET_DIR="${2:?}"; shift 2 ;;
		--port) PORT="${2:?}"; shift 2 ;;
		--file) ARCHIVE_FILE="${2:?}"; shift 2 ;;
		--remote) REMOTE="true"; shift ;;
		--no-service) NO_SERVICE="true"; shift ;;
		--uninstall) UNINSTALL="true"; shift ;;
		--purge) PURGE="true"; shift ;;
		--upgrade) UPGRADE="true"; shift ;;
		--full) FULL="true"; shift ;;
		-h | --help)
			sed -n '2,18p' "${BASH_SOURCE[0]}"
			exit 0
			;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
done

SERVICE_NAME="reelvault"
SERVICE_FILE="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${SERVICE_NAME}.service"
SERVICE_ACTIVE="false"

detect_service() {
	if command -v systemctl >/dev/null 2>&1 && [[ -f "${SERVICE_FILE}" ]]; then
		SERVICE_ACTIVE="true"
	fi
}

fetch() {
	local url="$1" out="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fSL --retry 3 -o "$out" "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$out" "$url"
	else
		die "need curl or wget to download files"
	fi
}

api_get() {
	local url="$1"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$url"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- "$url"
	else
		die "need curl or wget to download files"
	fi
}

detect_arch() {
	case "$(uname -m)" in
		x86_64) echo "linux-x64" ;;
		aarch64 | arm64) echo "linux-arm64" ;;
		*) die "unsupported architecture: $(uname -m)" ;;
	esac
}

ffmpeg_available() {
	command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1
}

install_ffmpeg_system() {
	log "Installing ffmpeg (required for transcoding)…"
	if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi

	if command -v apt-get >/dev/null 2>&1; then
		$SUDO apt-get update -qq && $SUDO apt-get install -y ffmpeg
	elif command -v dnf >/dev/null 2>&1; then
		$SUDO dnf install -y ffmpeg
	elif command -v pacman >/dev/null 2>&1; then
		$SUDO pacman -Sy --noconfirm ffmpeg
	elif command -v zypper >/dev/null 2>&1; then
		$SUDO zypper --non-interactive install ffmpeg
	else
		return 1
	fi
}

# Static builds — for distros whose repositories do not ship ffmpeg (e.g. Fedora
# without RPM Fusion) and for machines without root. Installed into $BIN_DIR,
# which start.sh puts on the PATH.
install_ffmpeg_static() {
	case "$(uname -m)" in
		x86_64) local flavor="amd64" ;;
		aarch64 | arm64) local flavor="arm64" ;;
		*) return 1 ;;
	esac

	local url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${flavor}-static.tar.xz"
	log "Downloading a static ffmpeg build (no distro package available)…"
	mkdir -p "$BIN_DIR"
	fetch "$url" "${TMP}/ffmpeg-static.tar.xz" || return 1
	tar -xJf "${TMP}/ffmpeg-static.tar.xz" -C "$TMP" || return 1

	local extracted
	extracted="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*-static' | head -1)"
	[[ -n "$extracted" ]] || return 1

	cp "${extracted}/ffmpeg" "${extracted}/ffprobe" "$BIN_DIR/"
	chmod +x "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"
}

install_ffmpeg() {
	if ffmpeg_available; then
		log "ffmpeg already installed: $(ffmpeg -version 2>/dev/null | head -1)"
		return 0
	fi

	if install_ffmpeg_system && ffmpeg_available; then
		return 0
	fi

	warn "the system package manager could not provide ffmpeg (some distros need extra repositories)."

	if install_ffmpeg_static && "$BIN_DIR/ffmpeg" -version >/dev/null 2>&1; then
		log "Static ffmpeg installed to ${BIN_DIR}."
		return 0
	fi

	warn "Install ffmpeg manually (https://ffmpeg.org) and re-run this installer."
	die "ffmpeg is required"
}

resolve_download_url() {
	local arch tag asset
	arch="$(detect_arch)"

	if [[ -n "$VERSION" ]]; then
		tag="${VERSION#v}"
		tag="v${tag}"
	else
		log "Resolving the latest release…"
		tag="$(api_get "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
		[[ -n "$tag" ]] || die "could not resolve the latest release; pass --version vX.Y.Z"
	fi

	asset="ReelVault-${tag#v}-${arch}.tar.gz"
	[[ "$FULL" == "true" ]] && asset="ReelVault-${tag#v}-${arch}-full.tar.gz"
	echo "https://github.com/${REPO}/releases/download/${tag}/${asset}"
}

uninstall() {
	detect_service
	if [[ "$SERVICE_ACTIVE" == "true" ]]; then
		log "Stopping and removing the systemd user service…"
		systemctl --user disable --quiet "${SERVICE_NAME}" 2>/dev/null || true
		systemctl --user stop "${SERVICE_NAME}" 2>/dev/null || true
		rm -f "${SERVICE_FILE}"
		systemctl --user daemon-reload 2>/dev/null || true
	fi

	if [[ -n "$TARGET_DIR" && -d "$TARGET_DIR" ]]; then
		if [[ "$PURGE" == "true" ]]; then
			log "Removing ${TARGET_DIR} (including data)…"
			rm -rf "${TARGET_DIR}"
		else
			log "Removing application files from ${TARGET_DIR} (data/ is kept)…"
			rm -rf "${TARGET_DIR}/bun" "${TARGET_DIR}/server" "${TARGET_DIR}/web" "${TARGET_DIR}/bin" "${TARGET_DIR}/start.sh" "${TARGET_DIR}/settings.env" "${TARGET_DIR}/README.txt"
		fi
	fi

	log "ReelVault uninstalled."
}

if [[ "$UNINSTALL" == "true" ]]; then
	uninstall
	exit 0
fi

TARGET_DIR="${TARGET_DIR:-$DEFAULT_DIR}"
BIN_DIR="${TARGET_DIR}/bin"
ARCH="$(detect_arch)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ "$FULL" != "true" ]]; then
	install_ffmpeg
fi

if [[ -n "$ARCHIVE_FILE" ]]; then
	[[ -f "$ARCHIVE_FILE" ]] || die "archive not found: $ARCHIVE_FILE"
	cp "$ARCHIVE_FILE" "${TMP}/archive.tar.gz"
else
	URL="$(resolve_download_url)"
	log "Downloading ${URL}…"
	fetch "$URL" "${TMP}/archive.tar.gz"
fi

log "Extracting…"
tar -xzf "${TMP}/archive.tar.gz" -C "$TMP"

mkdir -p "$TARGET_DIR"
log "Installing to ${TARGET_DIR}…"
cp -a "${TMP}/ReelVault/." "$TARGET_DIR/"
chmod +x "$TARGET_DIR/start.sh" "$TARGET_DIR/bun/bun"

if [[ "$FULL" == "true" ]]; then
	[[ -x "${BIN_DIR}/ffmpeg" && -x "${BIN_DIR}/ffprobe" ]] ||
		die "the full archive did not contain bin/ffmpeg and bin/ffprobe"
	chmod +x "${BIN_DIR}/ffmpeg" "${BIN_DIR}/ffprobe"
	log "Using the bundled ffmpeg/ffprobe from ${BIN_DIR}."
fi

# Single source of overrides for both the manual launcher and systemd.
HOST_BIND="127.0.0.1"
[[ "$REMOTE" == "true" ]] && HOST_BIND="0.0.0.0"
cat >"${TARGET_DIR}/settings.env" <<EOF
export APP_HOST="${HOST_BIND}"
export APP_PORT="${PORT}"
EOF

if [[ "$NO_SERVICE" == "true" ]] || ! command -v systemctl >/dev/null 2>&1; then
	if [[ "$NO_SERVICE" != "true" ]]; then
		warn "systemd not found — start ReelVault manually: ${TARGET_DIR}/start.sh"
	fi
	log "Done. Open http://localhost:${PORT} and create the administrator account."
	exit 0
fi

log "Creating the systemd user service…"
mkdir -p "$(dirname "${SERVICE_FILE}")"

cat >"${SERVICE_FILE}" <<EOF
[Unit]
Description=ReelVault media server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${TARGET_DIR}
EnvironmentFile=${TARGET_DIR}/settings.env
ExecStart=${TARGET_DIR}/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# A systemctl binary without a running user bus (containers, sudo shells) is
# not a failure — fall back to the manual launcher.
if ! systemctl --user daemon-reload 2>/dev/null; then
	warn "systemd user session is not available — start ReelVault manually: ${TARGET_DIR}/start.sh"
	log "Done. Open http://localhost:${PORT} and create the administrator account."
	exit 0
fi

systemctl --user enable --now "${SERVICE_NAME}" 2>/dev/null || warn "could not enable the service — start manually: ${TARGET_DIR}/start.sh"

sleep 2
if systemctl --user is-active --quiet "${SERVICE_NAME}"; then
	log "ReelVault is running."
else
	warn "service did not report active yet — check: journalctl --user -u ${SERVICE_NAME}"
fi

cat <<EOF

  ReelVault is installed.

    Address:  http://localhost:${PORT}
    Data:     ${TARGET_DIR}/data
    Service:  systemctl --user status|start|stop|restart ${SERVICE_NAME}

  Open the address above and create the administrator account.
  To reach the server from other devices, re-run with --remote
  and open port ${PORT} in your firewall.
EOF
