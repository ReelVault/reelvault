import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { systemSettingsStore } from "@/config/system-settings.store";

// The settings store clones array values on every read, so the extension list
// identity never matches. Key the Set off the store revision instead.
const extensionSetCache: { revision: number; extensions: Set<string> } = {
	revision: -1,
	extensions: new Set<string>(),
};
const BACKSLASH_REGEX = /\\+/g;
const MULTI_SLASH_REGEX = /\/+/g;

export function joinPath(...paths: string[]): string {
	return join(...paths);
}

export function resolvePath(...paths: string[]): string {
	return resolve(...paths);
}

export function relativePath(from: string, to: string): string {
	return relative(from, to);
}

export function getFileName(path: string): string {
	return basename(path);
}

export function getFileNameWithoutExt(path: string): string {
	const base = basename(path);
	const ext = extname(base);

	return ext ? base.slice(0, -ext.length) : base;
}

export function getDirName(path: string): string {
	return dirname(path);
}

export function getExtension(path: string): string {
	return extname(path).toLowerCase();
}

export function isVideoFile(path: string): boolean {
	const revision = systemSettingsStore.revision;
	if (revision !== extensionSetCache.revision) {
		extensionSetCache.extensions = new Set(serverConfig.media.supportedVideoExtensions);
		extensionSetCache.revision = revision;
	}

	return extensionSetCache.extensions.has(getExtension(path));
}

export function normalizePath(path: string): string {
	return path.replace(BACKSLASH_REGEX, "/").replace(MULTI_SLASH_REGEX, "/");
}

export function isAbsolutePath(path: string): boolean {
	return isAbsolute(path);
}

export function isSubpath(candidatePath: string, parentDir: string): boolean {
	const resolvedCandidate = resolve(candidatePath);
	const resolvedParent = resolve(parentDir);
	// A root parent ("/") must not become "//" — append the separator only
	// when the parent does not already end with one.
	const prefix = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;

	return resolvedCandidate.startsWith(prefix);
}

/** Resolves `candidate` under `root`; undefined when the result escapes the root. */
export function resolveWithin(root: string, candidate: string): string | undefined {
	const target = resolve(join(root, candidate));

	return isSubpath(target, root) ? target : undefined;
}
