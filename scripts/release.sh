#!/usr/bin/env bash
# ReelVault release builder — builds the release archives locally.
#
# Builds the SDK + web client, then assembles the native archives for every
# platform (linux-x64, linux-arm64, windows-x64) in two variants:
#   - default: ffmpeg/ffprobe are expected on PATH (the installer provides them)
#   - "-full":  a static ffmpeg/ffprobe is bundled into bin/ and start.sh /
#               start.bat point APP_FFMPEG_PATH / APP_FFPROBE_PATH at it
# Writes SHA256SUMS.txt to the output directory.
#
# Nothing is published: upload the contents of dist/release to a GitHub release
# yourself. The installer scripts are NOT shipped as assets — share them from
# the repository (stable URLs under install/). Docker is only built when asked.
#
# Usage:
#   ./scripts/release.sh <version> [options]
#
# Examples:
#   ./scripts/release.sh 1.2.0
#   ./scripts/release.sh v1.2.0 --docker
#   ./scripts/release.sh 1.2.0 --docker --push
#
# Options:
#   --website <dir>   website checkout      (default: ../website)
#   --out <dir>       Output directory                (default: dist/release)
#   --docker          Also build the Docker image
#   --push            Push the image to the registry (implies --docker)
#   -h, --help        Show this help
#
# Environment:
#   BUN_VERSION       Bundled Bun runtime version      (default: 1.4.2)
#   DOCKER_IMAGE      Image name                       (default: ghcr.io/reelvault/server)
#   FFMPEG_CACHE      Static ffmpeg download cache     (default: ~/.cache/reelvault-release)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.4.2}"
DOCKER_IMAGE="${DOCKER_IMAGE:-ghcr.io/reelvault/server}"
FFMPEG_CACHE="${FFMPEG_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/reelvault-release}"

WEBSITE_DIR="$ROOT/../website"
OUT_DIR="$ROOT/dist/release"
BUILD_DOCKER=false
PUSH_DOCKER=false

usage() {
	awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

die() {
	echo "error: $*" >&2
	exit 1
}

VERSION=""
while [ $# -gt 0 ]; do
	case "$1" in
		--website)
			[ $# -ge 2 ] || die "--website needs a value"
			WEBSITE_DIR="$2"
			shift 2
			;;
		--out)
			[ $# -ge 2 ] || die "--out needs a value"
			OUT_DIR="$2"
			shift 2
			;;
		--docker)
			BUILD_DOCKER=true
			shift
			;;
		--push)
			PUSH_DOCKER=true
			BUILD_DOCKER=true
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		-*)
			die "unknown option: $1"
			;;
		*)
			[ -z "$VERSION" ] || die "version already given: $VERSION (got extra '$1')"
			VERSION="$1"
			shift
			;;
	esac
done

[ -n "$VERSION" ] || {
	usage
	die "missing version (e.g. ./scripts/release.sh 1.2.0)"
}

VERSION_NO_V="${VERSION#v}"
[[ "$VERSION_NO_V" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || die "version must look like 1.2.3 or v1.2.3 (got '$VERSION')"

WEBSITE_DIR="$(cd "$WEBSITE_DIR" 2>/dev/null && pwd)" || die "website checkout not found (use --website <dir>)"
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"
mkdir -p "$FFMPEG_CACHE"

for tool in bun curl tar unzip xz sha256sum; do
	command -v "$tool" >/dev/null || die "missing required tool: $tool"
done
if [ "$BUILD_DOCKER" = true ]; then
	command -v docker >/dev/null || die "--docker needs the docker CLI"
fi

if command -v zip >/dev/null; then
	ZIP_DIR() { (cd "$(dirname "$2")" && zip -qr "$1" "$(basename "$2")"); }
elif command -v 7z >/dev/null; then
	ZIP_DIR() { (cd "$(dirname "$2")" && 7z a -tzip -mx=9 "$1" "$(basename "$2")" >/dev/null); }
elif command -v python3 >/dev/null; then
	ZIP_DIR() { python3 -m zipfile -c "$1" "$2"; }
else
	die "creating the Windows .zip needs one of: zip, 7z, python3"
fi

make_archive() { # <base path> <workdir> <appdir> <kind> <suffix>
	local out
	if [ "$4" = tar ]; then
		out="$1$5.tar.gz"
		tar -czf "$out" -C "$2" ReelVault
	else
		out="$1$5.zip"
		ZIP_DIR "$out" "$3"
	fi
	echo "    -> $(basename "$out")"
}

# Populates the cache with a static ffmpeg/ffprobe pair and echoes its directory.
ensure_linux_ffmpeg() { # <amd64|arm64>
	local flavor="$1"
	local archive="$FFMPEG_CACHE/ffmpeg-release-${flavor}-static.tar.xz"
	local dir="$FFMPEG_CACHE/ffmpeg-linux-${flavor}"
	if [ ! -x "$dir/ffmpeg" ] || [ ! -x "$dir/ffprobe" ]; then
		if [ ! -f "$archive" ]; then
			echo "    downloading static ffmpeg (${flavor})…" >&2
			curl -fsSL -o "$archive" "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${flavor}-static.tar.xz"
		fi
		rm -rf "$dir"
		mkdir -p "$dir"
		tar -xf "$archive" -C "$dir" --strip-components=1
		chmod +x "$dir/ffmpeg" "$dir/ffprobe"
	fi
	echo "$dir"
}

ensure_windows_ffmpeg() {
	local archive="$FFMPEG_CACHE/ffmpeg-release-essentials.zip"
	local dir="$FFMPEG_CACHE/ffmpeg-windows-x64"
	if [ ! -f "$dir/ffmpeg.exe" ] || [ ! -f "$dir/ffprobe.exe" ]; then
		if [ ! -f "$archive" ]; then
			echo "    downloading static ffmpeg (windows)…" >&2
			curl -fsSL -o "$archive" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
		fi
		rm -rf "$dir"
		mkdir -p "$dir/extract"
		unzip -q -o "$archive" -d "$dir/extract"
		local bin
		bin="$(find "$dir/extract" -type d -name bin | head -1)"
		[ -n "$bin" ] || die "unexpected ffmpeg archive layout (no bin/ directory)"
		cp "$bin/ffmpeg.exe" "$bin/ffprobe.exe" "$dir/"
		rm -rf "$dir/extract"
	fi
	echo "$dir"
}

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reelvault-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> ReelVault ${VERSION_NO_V}"
echo "    website: ${WEBSITE_DIR}"
echo "    output:  ${OUT_DIR}"
echo "    bun:     ${BUN_VERSION}"
echo "    ffmpeg:  ${FFMPEG_CACHE}"

echo "==> Building web client"
# The website resolves @reelvault/sdk from the registry like any dependency.
( cd "$WEBSITE_DIR" && bun install --frozen-lockfile --no-progress )
( cd "$WEBSITE_DIR" && bun run build )
[ -d "$WEBSITE_DIR/dist" ] || die "website build produced no dist/ directory"

# name|os|cpu|bun asset|bun binary|launcher|archive kind|ffmpeg source
TARGETS=(
	"linux-x64|linux|x64|bun-linux-x64.zip|bun|start.sh|tar|linux-amd64"
	"linux-arm64|linux|arm64|bun-linux-aarch64.zip|bun|start.sh|tar|linux-arm64"
	"windows-x64|win32|x64|bun-windows-x64.zip|bun.exe|start.bat|zip|windows"
)

for TARGET in "${TARGETS[@]}"; do
	IFS='|' read -r NAME OS CPU BUN_ASSET BUN_BIN LAUNCHER KIND FFMPEG_SRC <<<"$TARGET"
	echo "==> Assembling ${NAME} (default + full)"

	APP="$WORK/$NAME/ReelVault"
	rm -rf "$WORK/$NAME"
	mkdir -p "$APP/bun" "$APP/server"

	curl -fsSL -o "$WORK/$NAME/bun.zip" "$BUN_URL/$BUN_ASSET"
	unzip -q "$WORK/$NAME/bun.zip" -d "$WORK/$NAME/bun-extract"
	mv "$WORK/$NAME/bun-extract/${BUN_ASSET%.zip}/$BUN_BIN" "$APP/bun/$BUN_BIN"

	cp "$ROOT/install/$LAUNCHER" "$ROOT/install/README.txt" "$APP/"

	cp "$ROOT/package.json" "$ROOT/bun.lock" "$ROOT/bunfig.toml" "$ROOT/tsconfig.json" "$APP/server/"
	cp -r "$ROOT/src" "$APP/server/"
	(
		cd "$APP/server"
		bun install --production --frozen-lockfile --no-progress --os="$OS" --cpu="$CPU"
	)

	cp -r "$WEBSITE_DIR/dist" "$APP/web"
	chmod +x "$APP/$LAUNCHER" "$APP/bun/$BUN_BIN"

	make_archive "$OUT_DIR/ReelVault-${VERSION_NO_V}-${NAME}" "$WORK/$NAME" "$APP" "$KIND" ""

	# Full variant: drop the static ffmpeg/ffprobe pair into bin/ and re-pack.
	mkdir -p "$APP/bin"
	if [ "$FFMPEG_SRC" = windows ]; then
		FFMPEG_DIR="$(ensure_windows_ffmpeg)"
		cp "$FFMPEG_DIR/ffmpeg.exe" "$FFMPEG_DIR/ffprobe.exe" "$APP/bin/"
	else
		FFMPEG_DIR="$(ensure_linux_ffmpeg "${FFMPEG_SRC#linux-}")"
		cp "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" "$APP/bin/"
		chmod +x "$APP/bin/ffmpeg" "$APP/bin/ffprobe"
	fi
	make_archive "$OUT_DIR/ReelVault-${VERSION_NO_V}-${NAME}" "$WORK/$NAME" "$APP" "$KIND" "-full"
done

echo "==> Checksums"
( cd "$OUT_DIR" && sha256sum ./*.tar.gz ./*.zip >SHA256SUMS.txt )

if [ "$BUILD_DOCKER" = true ]; then
	echo "==> Building Docker image ${DOCKER_IMAGE}:${VERSION_NO_V}"
	DOCKER_ARGS=(
		--build-context "website=$WEBSITE_DIR"
		-t "${DOCKER_IMAGE}:${VERSION_NO_V}"
		-t "${DOCKER_IMAGE}:latest"
	)
	if [ "$PUSH_DOCKER" = true ]; then
		echo "==> Pushing to ${DOCKER_IMAGE}"
		DOCKER_ARGS+=(--push)
	else
		DOCKER_ARGS+=(--load)
	fi
	docker buildx build "${DOCKER_ARGS[@]}" "$ROOT"
fi

echo
echo "Done. Release assets are in ${OUT_DIR}:"
ls -1 "$OUT_DIR"
echo
echo "Installers are not shipped here — share them from the repository:"
echo "  https://raw.githubusercontent.com/ReelVault/reelvault/main/install/install.sh"
echo "  https://raw.githubusercontent.com/ReelVault/reelvault/main/install/install.ps1"
echo
echo "Upload the archives to the GitHub release, e.g.:"
echo "  gh release create v${VERSION_NO_V} --repo ReelVault/reelvault --title \"ReelVault v${VERSION_NO_V}\" --generate-notes \"${OUT_DIR}\"/*.tar.gz \"${OUT_DIR}\"/*.zip \"${OUT_DIR}\"/SHA256SUMS.txt"
