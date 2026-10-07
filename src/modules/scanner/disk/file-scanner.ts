import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils, type ScannedFileEntry } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import type { FilePathChanges } from "../scanner.types";
import { compareFilePaths, filterPathsWithinRoots } from "../utils/scanner.utils";

interface ScanOptions {
	paths: string[];
	extensions?: readonly string[] | undefined;
	maxDepth?: number | undefined;
	signal?: AbortSignal | undefined;
}

/** Applies the defaults shared by `scan` and `scanWithStats`. */
function resolveScanOptions(options: ScanOptions): {
	paths: string[];
	extensions: readonly string[];
	maxDepth: number;
	signal: AbortSignal | undefined;
} {
	return {
		paths: options.paths,
		extensions: options.extensions ?? serverConfig.media.supportedVideoExtensions,
		maxDepth: options.maxDepth ?? 10,
		signal: options.signal,
	};
}

class FileScannerService extends BaseService {
	constructor() {
		super("FileScannerService");
	}

	async scan(options: ScanOptions): Promise<string[]> {
		const { paths, extensions, maxDepth, signal } = resolveScanOptions(options);
		const scannedPaths = await PromiseUtils.mapConcurrent(
			paths,
			systemResourcesService.getScannerConcurrency(),
			async (path) => {
				const entries = await DirUtils.scanFiles(path, extensions, maxDepth, signal);

				return entries.filter((filePath) => !isIgnoredPath(filePath, path));
			},
			signal,
		);

		const seen = new Set<string>();
		for (const entries of scannedPaths) {
			for (const filePath of entries) {
				seen.add(PathUtils.resolve(filePath));
			}
		}

		return [...seen];
	}

	async scanWithStats(options: ScanOptions): Promise<ScannedFileEntry[]> {
		const { paths, extensions, maxDepth, signal } = resolveScanOptions(options);
		const scannedEntries = await PromiseUtils.mapConcurrent(
			paths,
			systemResourcesService.getScannerConcurrency(),
			async (path) => {
				const entries = await DirUtils.scanFilesWithStats(path, extensions, maxDepth, signal);

				return entries.filter((entry) => !isIgnoredPath(entry.filePath, path));
			},
			signal,
		);

		const seen = new Set<string>();
		const uniqueEntries: ScannedFileEntry[] = [];
		for (const entries of scannedEntries) {
			for (const entry of entries) {
				const resolvedPath = PathUtils.resolve(entry.filePath);
				if (!seen.has(resolvedPath)) {
					seen.add(resolvedPath);
					uniqueEntries.push({
						...entry,
						filePath: resolvedPath,
					});
				}
			}
		}

		return uniqueEntries;
	}

	diff(filesOnDisk: string[], filesInDatabase: string[], scanRoots: string[]): FilePathChanges {
		return compareFilePaths(filesOnDisk, filterPathsWithinRoots(filesInDatabase, scanRoots));
	}
}

/**
 * Wildcard ignore patterns (`*`, `?`) matched against the file name and the
 * scan-relative path — patterns without a separator target names anywhere in
 * the tree, patterns with one anchor to the scan root.
 */
const TRAILING_SLASHES_REGEX = /\/+$/;

interface CompiledIgnorePattern {
	regex: RegExp;
	/** Separator-bearing patterns anchor to the scan-relative path, others to a name. */
	pathScoped: boolean;
}

// Patterns are settings-backed and stable across a scan; compile each raw
// pattern once instead of once per file per pattern.
const compiledIgnorePatterns = new Map<string, CompiledIgnorePattern | null>();
const MAX_COMPILED_IGNORE_PATTERNS = 64;

function compileIgnorePattern(pattern: string): CompiledIgnorePattern | null {
	const cached = compiledIgnorePatterns.get(pattern);
	if (cached !== undefined) return cached;

	const trimmed = pattern.trim().toLowerCase();
	let compiled: CompiledIgnorePattern | null = null;
	if (trimmed) {
		const escaped = trimmed
			.replaceAll(/[\\+(){}[\]$^|.]/g, "\\$&")
			.replaceAll("*", "\u0000")
			.replaceAll("?", "\u0001")
			.replaceAll("\u0000", ".*")
			.replaceAll("\u0001", ".");
		compiled = { regex: new RegExp(`^${escaped}$`), pathScoped: escaped.includes("/") };
	}

	if (compiledIgnorePatterns.size >= MAX_COMPILED_IGNORE_PATTERNS) compiledIgnorePatterns.clear();
	compiledIgnorePatterns.set(pattern, compiled);

	return compiled;
}

export function matchesIgnorePattern(filePath: string, rootPath: string, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;

	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	const root = rootPath.replaceAll("\\", "/").replace(TRAILING_SLASHES_REGEX, "").toLowerCase();
	const relative = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	let segments: string[] | undefined;

	return patterns.some((pattern) => {
		const compiled = compileIgnorePattern(pattern);
		if (!compiled) return false;

		// Name-only patterns match any path segment, so ignoring a folder name
		// skips everything inside it; separator-bearing patterns match the
		// scan-relative path.
		if (compiled.pathScoped) return compiled.regex.test(relative);

		segments ??= relative.split("/");

		return segments.some((segment) => compiled.regex.test(segment));
	});
}

/**
 * Scene-release extras bundled next to the real titles ("sample.mkv" demos the
 * encode). Left in, one attaches to the movie as a bogus second version — the
 * scanner skips the name everywhere, like the dot-file rule.
 */
const EXTRA_FILE_NAME_PATTERN = /^sample\.[a-z0-9]+$/i;

/** Editor backup / partial-download suffixes that never hold a complete video. */
const TEMPORARY_FILE_SUFFIXES = ["~", ".tmp", ".part", ".crdownload"] as const;

/**
 * Fixed (non-configurable) scanner ignore rules: hidden dot-segments and
 * editor/partial-download suffixes. Must be given a path relative to the scan
 * root (or a bare file name) — an absolute path would classify a library that
 * lives under a hidden directory as entirely ignored.
 */
export function isIgnoredRelativePath(filePath: string): boolean {
	const segments = filePath.replaceAll("\\", "/").split("/");
	for (const segment of segments) {
		if (segment.startsWith(".") && segment !== "." && segment !== "..") return true;

		if (TEMPORARY_FILE_SUFFIXES.some((suffix) => segment.endsWith(suffix))) return true;
	}

	return false;
}

function isIgnoredPath(filePath: string, rootPath: string): boolean {
	if (EXTRA_FILE_NAME_PATTERN.test(PathUtils.getFileName(filePath))) return true;

	return matchesIgnorePattern(filePath, rootPath, serverConfig.media.ignorePatterns);
}

export const fileScannerService = new FileScannerService();
