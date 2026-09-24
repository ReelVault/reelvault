#!/usr/bin/env bash
# ReelVault release builder — builds the release archives locally.
#
# Builds the SDK + web client, then assembles the native archives for every
# platform (linux-x64, linux-arm64, windows-x64) in two variants:
#   - default: ffmpeg/ffprobe are expected on PATH (the installer provides them)
#   - "-full":  a pinned static ffmpeg/ffprobe (SHA256-verified, cached under
#               dist/cache/ffmpeg) is bundled into bin/ and start.sh / start.bat
#               point APP_FFMPEG_PATH / APP_FFPROBE_PATH at it
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
#   FFMPEG_CACHE      Pinned ffmpeg build cache        (default: dist/cache/ffmpeg)
#
# The -full variant bundles the pinned ffmpeg builds from FFMPEG_PINS (version +
# URL + SHA256). Each archive is verified before use, so an upstream regression
# or a silently replaced file stops the build instead of shipping. Bumping a
# version means updating its FFMPEG_PINS entry.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.4.2}"
DOCKER_IMAGE="${DOCKER_IMAGE:-ghcr.io/reelvault/server}"
FFMPEG_CACHE="${FFMPEG_CACHE:-$ROOT/dist/cache/ffmpeg}"

# Pinned static ffmpeg builds for the -full variant: <source>|<version>|<url>|<sha256>.
# The Linux archives come from johnvansickle.com (rolling URLs — the SHA256 keeps
# them pinned); Windows comes from the immutable GyanD/codexffmpeg release tag.
FFMPEG_PINS=(
	"linux-amd64|7.0.2|https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz|abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"
	"linux-arm64|7.0.2|https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz|f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1"
	"windows|8.1.2|https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip|db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
)

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

# Echoes "<version>|<url>|<sha256>" for a pinned ffmpeg source.
ffmpeg_pin() { # <source>
	local pin
	for pin in "${FFMPEG_PINS[@]}"; do
		if [ "${pin%%|*}" = "$1" ]; then
			echo "${pin#*|}"
			return 0
		fi
	done
	die "no ffmpeg pin for '$1' (add it to FFMPEG_PINS in ${BASH_SOURCE[0]})"
}

# Ensures a pinned, SHA256-verified ffmpeg/ffprobe pair and echoes its directory.
# Cache layout: <cache>/<version>/<source>/ with the downloaded archive next to it.
ensure_ffmpeg() { # <source> <version> <url> <sha256>
	local src="$1" version="$2" url="$3" sha256="$4"
	local dir="$FFMPEG_CACHE/$version/$src"
	local archive="$FFMPEG_CACHE/$version/$(basename "$url")"
	local suffix=""
	if [ "$src" = windows ]; then
		suffix=".exe"
	fi

	if [ -f "$dir/.complete" ] && [ "$(cat "$dir/.complete")" = "$version $sha256" ] &&
		[ -f "$dir/ffmpeg$suffix" ] && [ -f "$dir/ffprobe$suffix" ]; then
		echo "$dir"
		return 0
	fi

	mkdir -p "$FFMPEG_CACHE/$version"
	if [ ! -f "$archive" ]; then
		echo "    downloading ffmpeg ${version} (${src})…" >&2
		rm -f "$archive.part"
		curl -fsSL -o "$archive.part" "$url"
		mv "$archive.part" "$archive"
	fi

	local actual
	actual="$(sha256sum "$archive" | cut -d' ' -f1)"
	if [ "$actual" != "$sha256" ]; then
		die "$(basename "$archive") failed the SHA256 check
  expected $sha256
  actual   $actual
If the pin was bumped on purpose, delete the cached archive and re-run; if not, upstream changed the build — update FFMPEG_PINS in ${BASH_SOURCE[0]}."
	fi

	local tmp="$WORK/ffmpeg-$src"
	rm -rf "$tmp" "$dir"
	mkdir -p "$tmp" "$dir"
	if [ "$src" = windows ]; then
		unzip -q -o "$archive" -d "$tmp"
	else
		tar -xf "$archive" -C "$tmp"
	fi

	local binary
	binary="$(find "$tmp" -type f -name "ffmpeg$suffix" -print -quit)"
	[ -n "$binary" ] || die "unexpected ffmpeg archive layout in $(basename "$archive") (no ffmpeg binary)"
	local bindir
	bindir="$(dirname "$binary")"
	[ -f "$bindir/ffprobe$suffix" ] || die "unexpected ffmpeg archive layout in $(basename "$archive") (no ffprobe binary)"
	cp "$bindir/ffmpeg$suffix" "$bindir/ffprobe$suffix" "$dir/"
	if [ "$src" != windows ]; then
		chmod +x "$dir/ffmpeg" "$dir/ffprobe"
	fi

	# Both archives carry the version in their top-level directory name; this
	# catches a pin that points at the wrong build.
	[ -n "$(find "$tmp" -maxdepth 1 -type d -name "*$version*" -print -quit)" ] ||
		die "expected ffmpeg ${version} in $(basename "$archive") — check FFMPEG_PINS in ${BASH_SOURCE[0]}"

	# Run the binary too when the host architecture matches (cross builds can't).
	case "$src:$(uname -m)" in
		linux-amd64:x86_64 | linux-arm64:aarch64 | linux-arm64:arm64)
			local reported
			reported="$("$dir/ffmpeg" -version 2>/dev/null | head -1 || true)"
			case "$reported" in
				*"$version"*) ;;
				*) die "ffmpeg ${version} reported an unexpected version: ${reported:-no output}" ;;
			esac
			;;
	esac

	printf '%s %s\n' "$version" "$sha256" >"$dir/.complete"
	echo "$dir"
}

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reelvault-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> ReelVault ${VERSION_NO_V}"
echo "    website: ${WEBSITE_DIR}"
echo "    output:  ${OUT_DIR}"
echo "    bun:     ${BUN_VERSION}"
FFMPEG_LABEL=""
for PIN in "${FFMPEG_PINS[@]}"; do
	IFS='|' read -r PIN_SRC PIN_VERSION _ <<<"$PIN"
	FFMPEG_LABEL+="${FFMPEG_LABEL:+, }${PIN_SRC} ${PIN_VERSION}"
done
echo "    ffmpeg:  ${FFMPEG_LABEL} (cache: ${FFMPEG_CACHE})"

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

	# Full variant: drop the pinned static ffmpeg/ffprobe pair into bin/ and re-pack.
	mkdir -p "$APP/bin"
	FFMPEG_PIN="$(ffmpeg_pin "$FFMPEG_SRC")"
	IFS='|' read -r FFMPEG_VERSION FFMPEG_URL FFMPEG_SHA256 <<<"$FFMPEG_PIN"
	FFMPEG_DIR="$(ensure_ffmpeg "$FFMPEG_SRC" "$FFMPEG_VERSION" "$FFMPEG_URL" "$FFMPEG_SHA256")"
	if [ "$FFMPEG_SRC" = windows ]; then
		cp "$FFMPEG_DIR/ffmpeg.exe" "$FFMPEG_DIR/ffprobe.exe" "$APP/bin/"
	else
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
