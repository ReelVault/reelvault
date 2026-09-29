import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "@/utils/type.utils";

export type UpdateInstallType = "archive" | "docker" | "dev";
export type UpdateFlavor = "default" | "full";
export type UpdateComponent = "server" | "web";

export const SERVER_DIR_NAMES = ["server", "bun", "bin"] as const;
export const LAUNCHER_FILE_NAMES = ["start.sh", "start.bat", "README.txt"] as const;
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
 * The module lives at `<root>/server/src`, so two levels up land on the root
 * in both the release archives and the repository checkout.
 */
export function resolveInstallRoot(): string {
	return resolve(import.meta.dir, "..", "..");
}

export function isDockerEnvironment(): boolean {
	return existsSync("/.dockerenv");
}

export function detectInstallType(root = resolveInstallRoot()): UpdateInstallType {
	if (isDockerEnvironment()) return "docker";
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
		const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
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
