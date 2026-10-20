import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { safeParseJson } from "@/utils/json.utils";
import { isRecord } from "@/utils/type.utils";

export type UpdateInstallType = "archive" | "docker" | "dev";
export type UpdateFlavor = "default" | "full";
export type UpdateComponent = "server" | "web";

export const SERVER_DIR_NAMES = ["server", "bun", "bin"] as const;
export const LAUNCHER_FILE_NAMES = ["start.sh", "start.bat"] as const;
export const WEB_DIR_NAMES = ["web"] as const;

/** Directory that holds the swapped-out previous version after an update. */
export const PREVIOUS_DIR = ".previous";
/** Per-component marker files inside PREVIOUS_DIR carrying the replaced versions. */
export const SERVER_VERSION_MARKER = "SERVER_VERSION";
export const WEB_VERSION_MARKER = "WEB_VERSION";
/** Scratch directory a downloaded release is extracted into before the swap. */
export const STAGING_DIR = ".update-staging";
/** Windows keeps the extracted release here until the post-exit swap script runs. */
export const PENDING_DIR = ".update-pending";
/** Discard area for the displaced version during a rollback; removed on next boot. */
export const DISCARD_DIR = ".update-discard";

/**
 * Root of the application layout: `<root>/server`, `<root>/web`, `<root>/bun`.
 * The module lives at `<root>/server/src/app/updates`, so four levels
 * up land on the install root; in the repository checkout they land on the
 * repo directory, which has no `bun/` and therefore still detects as "dev".
 */
export function resolveInstallRoot(): string {
	return resolve(import.meta.dir, "..", "..", "..", "..");
}

export type ContainerRuntime = "docker" | "podman";
export type SystemdScope = "user" | "system";

export interface UpdateEnvironment {
	/** Container engine the server runs in; null on a bare host. */
	container: ContainerRuntime | null;
	/** Runs without root: a rootless Podman container, or a non-root process on the host. */
	rootless: boolean;
	/** Where the reelvault unit is registered: the user manager or the system manager. */
	systemd: SystemdScope | null;
}

/** Podman writes this marker into every container it starts; Docker writes `/.dockerenv` instead. */
const PODMAN_MARKER_FILE = "/run/.containerenv";
const ROOTLESS_MARKER_REGEX = /^rootless=1$/m;

export function detectContainerRuntime(exists: (path: string) => boolean = existsSync): ContainerRuntime | null {
	if (exists("/.dockerenv")) return "docker";
	if (exists(PODMAN_MARKER_FILE)) return "podman";

	return null;
}

/** Podman records `rootless=1` in the marker for containers started without root on the host. */
export function isRootlessMarker(markerContents: string): boolean {
	return ROOTLESS_MARKER_REGEX.test(markerContents);
}

function readPodmanMarker(): string {
	try {
		return readFileSync(PODMAN_MARKER_FILE, "utf8");
	} catch {
		return "";
	}
}

export function detectRootless(container: ContainerRuntime | null): boolean {
	if (container === "podman") return isRootlessMarker(readPodmanMarker());

	return typeof process.getuid === "function" && process.getuid() !== 0;
}

export function detectInstallType(root = resolveInstallRoot()): UpdateInstallType {
	// Container installs (Docker or Podman) ship as images: the panel cannot replace the files in place.
	if (detectContainerRuntime()) return "docker";
	if (existsSync(join(root, "bun")) && existsSync(join(root, "server", "package.json"))) return "archive";

	return "dev";
}

/** `-full` bundles install a static ffmpeg pair into `<root>/bin`. */
export function detectFlavor(root = resolveInstallRoot()): UpdateFlavor {
	return existsSync(join(root, "bin", "ffmpeg")) ? "full" : "default";
}

/**
 * Version of the web UI installed at `<root>/web` — the copy an update
 * actually replaces (the served APP_WEB_DIST may point elsewhere).
 */
export function readInstalledWebVersion(root: string): string | null {
	const marker = join(root, "web", "version.json");
	if (!existsSync(marker)) return null;

	try {
		const parsed = safeParseJson(readFileSync(marker, "utf8"));
		if (!isRecord(parsed)) return null;

		const { version } = parsed;

		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

export function isPreviousVersionPresent(component: UpdateComponent, root = resolveInstallRoot()): boolean {
	return existsSync(join(root, PREVIOUS_DIR, componentMarkerName(component)));
}

export function componentMarkerName(component: UpdateComponent) {
	return component === "server" ? SERVER_VERSION_MARKER : WEB_VERSION_MARKER;
}

/** The installer registers a user unit with this exact name. */
export function systemdServiceFile(): string {
	return join(homedir(), ".config", "systemd", "user", "reelvault.service");
}

export function systemdServiceRegistered(): boolean {
	return existsSync(systemdServiceFile());
}

/** A system-wide install registers the unit with the system manager instead of the user manager. */
export function systemdSystemServiceFile(): string {
	return "/etc/systemd/system/reelvault.service";
}

export function detectSystemdScope(): SystemdScope | null {
	if (systemdServiceRegistered()) return "user";
	if (existsSync(systemdSystemServiceFile())) return "system";

	return null;
}

export function describeUpdateEnvironment(): UpdateEnvironment {
	const container = detectContainerRuntime();

	return { container, rootless: detectRootless(container), systemd: detectSystemdScope() };
}
