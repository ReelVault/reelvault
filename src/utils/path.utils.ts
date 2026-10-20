import { basename, extname, join, resolve, sep } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { revisionMemo } from "@/config/settings-revision.cache";

// The settings store clones array values on every read, so the extension list
// identity never matches. Key the Set off the store revision instead.
const supportedVideoExtensions = revisionMemo(() => new Set(serverConfig.media.supportedVideoExtensions));
const BACKSLASH_REGEX = /\\+/g;
const MULTI_SLASH_REGEX = /\/+/g;

export function getFileNameWithoutExt(path: string): string {
	const base = basename(path);
	const ext = extname(base);

	return ext ? base.slice(0, -ext.length) : base;
}

export function getExtension(path: string): string {
	return extname(path).toLowerCase();
}

export function isVideoFile(path: string): boolean {
	return supportedVideoExtensions().has(getExtension(path));
}

export function normalizePath(path: string): string {
	return path.replace(BACKSLASH_REGEX, "/").replace(MULTI_SLASH_REGEX, "/");
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
