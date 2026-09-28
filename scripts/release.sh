#!/usr/bin/env bash
# ReelVault SERVER release builder — builds the server release archive only.
#
# Assembles the native server artifact for every platform (linux-x64,
# linux-arm64, windows-x64): the bundled Bun runtime, the server sources with
# production dependencies, and the launchers. The web UI is a separate release
# built from the website repository (scripts/release-web.sh), and the combined
# fresh-install bundles are assembled in the installer repository.
#
# Writes SHA256SUMS.txt to the output directory. Nothing is published: upload
# the contents of dist/release to a GitHub release yourself.
#
# Usage:
#   ./scripts/release.sh <version>
#
# Environment:
#   BUN_VERSION       Bundled Bun runtime version      (default: 1.4.2)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_VERSION="${BUN_VERSION:-1.4.2}"
OUT_DIR="$ROOT/dist/release"

SEMVER_REGEX='^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'
BUN_VERSION_REGEX='^[0-9]+\.[0-9]+\.[0-9]+$'

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

# Both values end up in file names and download URLs, so they are anchored.
VERSION_NO_V="${VERSION#v}"
[[ "$VERSION_NO_V" =~ $SEMVER_REGEX ]] || die "version must look like 1.2.3 or v1.2.3 (got '$VERSION')"
[[ "$BUN_VERSION" =~ $BUN_VERSION_REGEX ]] || die "BUN_VERSION must look like 1.4.2 (got '$BUN_VERSION')"

for tool in bun curl tar unzip sha256sum awk; do
	command -v "$tool" >/dev/null || die "missing required tool: $tool"
done

# Dependencies are installed by the bun on PATH, but run by the bundled one.
if [ "$(bun --version)" != "$BUN_VERSION" ]; then
	echo "warning: bun $(bun --version) installs the dependencies, bun ${BUN_VERSION} is bundled" >&2
fi

# The archives are assembled from tracked files: fail early, not halfway through.
for required in bun.lock bunfig.toml tsconfig.json package.json src install/start.sh install/start.bat install/README.txt; do
	[ -e "$ROOT/$required" ] || die "missing required file in the repository: $required"
done

# $1 = absolute zip path, $2 = directory that becomes the zip's top-level entry.
if command -v zip >/dev/null; then
	ZIP_DIR() { (cd "$(dirname "$2")" && zip -qr "$1" "$(basename "$2")"); }
elif command -v 7z >/dev/null; then
	ZIP_DIR() { (cd "$(dirname "$2")" && 7z a -tzip -mx=9 "$1" "$(basename "$2")" >/dev/null); }
elif command -v python3 >/dev/null; then
	ZIP_DIR() { (cd "$(dirname "$2")" && python3 -m zipfile -c "$1" "$(basename "$2")"); }
else
	die "creating the Windows .zip needs one of: zip, 7z, python3"
fi

# Absolute path, created here: nothing below deletes it (unlike the website
# release, this build does not empty dist/).
OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd)"

# Never mix in leftovers from a previous run (they would end up in
# SHA256SUMS.txt and in the release).
rm -f "$OUT_DIR"/ReelVault-Server-*.tar.gz "$OUT_DIR"/ReelVault-Server-*.zip "$OUT_DIR/SHA256SUMS.txt"

BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/reelvault-release.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> ReelVault Server ${VERSION_NO_V}"
echo "    output:  ${OUT_DIR}"
echo "    bun:     ${BUN_VERSION}"

# The bundled runtime ships to users, so it is verified against the checksums
# Bun publishes with every release.
curl -fsSL --retry 3 -o "$WORK/bun-SHASUMS256.txt" "$BUN_URL/SHASUMS256.txt"

# name|os|cpu|bun asset|bun binary|launcher|archive kind
TARGETS=(
	"linux-x64|linux|x64|bun-linux-x64.zip|bun|start.sh|tar"
	"linux-arm64|linux|arm64|bun-linux-aarch64.zip|bun|start.sh|tar"
	"windows-x64|win32|x64|bun-windows-x64.zip|bun.exe|start.bat|zip"
)

ARCHIVES=()

for TARGET in "${TARGETS[@]}"; do
	IFS='|' read -r NAME OS CPU BUN_ASSET BUN_BIN LAUNCHER KIND <<<"$TARGET"
	echo "==> Assembling server archive for ${NAME}"

	APP="$WORK/$NAME/ReelVault"
	rm -rf "$WORK/$NAME"
	mkdir -p "$APP/bun" "$APP/server"

	curl -fsSL --retry 3 -o "$WORK/$NAME/bun.zip" "$BUN_URL/$BUN_ASSET"

	expected="$(awk -v f="$BUN_ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$WORK/bun-SHASUMS256.txt")"
	[ -n "$expected" ] || die "no checksum for $BUN_ASSET in SHASUMS256.txt"
	actual="$(sha256sum "$WORK/$NAME/bun.zip" | awk '{ print $1 }')"
	[ "$expected" = "$actual" ] || die "checksum mismatch for $BUN_ASSET (expected $expected, got $actual)"

	unzip -q "$WORK/$NAME/bun.zip" -d "$WORK/$NAME/bun-extract"
	mv "$WORK/$NAME/bun-extract/${BUN_ASSET%.zip}/$BUN_BIN" "$APP/bun/$BUN_BIN"

	cp "$ROOT/install/$LAUNCHER" "$ROOT/install/README.txt" "$APP/"

	cp "$ROOT/package.json" "$ROOT/bun.lock" "$ROOT/bunfig.toml" "$ROOT/tsconfig.json" "$APP/server/"
	cp -r "$ROOT/src" "$APP/server/"
	(
		cd "$APP/server"
		bun install --production --frozen-lockfile --no-progress --os="$OS" --cpu="$CPU"
	)

	chmod +x "$APP/$LAUNCHER" "$APP/bun/$BUN_BIN"

	if [ "$KIND" = tar ]; then
		out="$OUT_DIR/ReelVault-Server-${VERSION_NO_V}-${NAME}.tar.gz"
		tar -czf "$out" -C "$WORK/$NAME" ReelVault
	else
		out="$OUT_DIR/ReelVault-Server-${VERSION_NO_V}-${NAME}.zip"
		ZIP_DIR "$out" "$APP"
	fi
	ARCHIVES+=( "$(basename "$out")" )
	echo "    -> $(basename "$out")"
done

# Bare file names (no './'): the server's checksumForFile matches them exactly.
# Listing the archives explicitly also guarantees no stale file is included.
echo "==> Checksums"
[ "${#ARCHIVES[@]}" -eq "${#TARGETS[@]}" ] || die "expected ${#TARGETS[@]} archives, built ${#ARCHIVES[@]}"
( cd "$OUT_DIR" && sha256sum "${ARCHIVES[@]}" >SHA256SUMS.txt )

echo
echo "Done. Server release assets are in ${OUT_DIR}:"
ls -1 "$OUT_DIR"
echo
echo "Upload the archives to a GitHub release of ReelVault/reelvault, e.g.:"
echo "  gh release create v${VERSION_NO_V} --repo ReelVault/reelvault --title \"ReelVault Server v${VERSION_NO_V}\" --generate-notes \"${OUT_DIR}\"/*.tar.gz \"${OUT_DIR}\"/*.zip \"${OUT_DIR}\"/SHA256SUMS.txt"