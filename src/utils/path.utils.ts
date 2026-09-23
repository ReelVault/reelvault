import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { serverConfig } from "@/server.config";

const extensionSetCache: { extensionsArray: readonly string[] | undefined; extensions: Set<string> } = {
	extensionsArray: undefined,
	extensions: new Set<string>(),
};
const BACKSLASH_REGEX = /\\+/g;
const MULTI_SLASH_REGEX = /\/+/g;

export const PathUtils = {
	join(...paths: string[]): string {
		return join(...paths);
	},

	resolve(...paths: string[]): string {
		return resolve(...paths);
	},

	relative(from: string, to: string): string {
		return relative(from, to);
	},

	getFileName(path: string): string {
		return basename(path);
	},

	getFileNameWithoutExt(path: string): string {
		const base = basename(path);
		const ext = extname(base);

		return ext ? base.slice(0, -ext.length) : base;
	},

	getDirName(path: string): string {
		return dirname(path);
	},

	getExtension(path: string): string {
		return extname(path).toLowerCase();
	},

	isVideoFile(path: string): boolean {
		const extensions = serverConfig.media.supportedVideoExtensions;
		if (extensions !== extensionSetCache.extensionsArray) {
			extensionSetCache.extensionsArray = extensions;
			extensionSetCache.extensions = new Set(extensions);
		}

		return extensionSetCache.extensions.has(PathUtils.getExtension(path));
	},

	normalize(path: string): string {
		return path.replace(BACKSLASH_REGEX, "/").replace(MULTI_SLASH_REGEX, "/");
	},

	isAbsolute(path: string): boolean {
		return isAbsolute(path);
	},

	isSubpath(candidatePath: string, parentDir: string): boolean {
		const resolvedCandidate = resolve(candidatePath);
		const resolvedParent = resolve(parentDir);
		// A root parent ("/") must not become "//" — append the separator only
		// when the parent does not already end with one.
		const prefix = resolvedParent.endsWith(sep) ? resolvedParent : `${resolvedParent}${sep}`;

		return resolvedCandidate.startsWith(prefix);
	},
};
