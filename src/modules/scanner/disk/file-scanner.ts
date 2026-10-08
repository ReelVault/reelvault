import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils, type ScannedFileEntry } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseTimeoutError, PromiseUtils } from "@/utils/promise.utils";

interface ScanOptions {
	paths: string[];
	extensions?: readonly string[] | undefined;
	maxDepth?: number | undefined;
	signal?: AbortSignal | undefined;
}

/**
 * A path whose glob walk exceeds this is skipped for the current run: a dead
 * NFS/CIFS mount can hang `readdir` indefinitely, which would hold the scan
 * task (and its worker dedupe key) for the full 2 h worker timeout.
 */
const DEFAULT_PATH_SCAN_TIMEOUT_MS = 2 * MINUTE;

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

export class FileScannerService extends BaseService {
	private readonly pathScanTimeoutMs: number;

	constructor(pathScanTimeoutMs: number = DEFAULT_PATH_SCAN_TIMEOUT_MS) {
		super("FileScannerService");
		this.pathScanTimeoutMs = pathScanTimeoutMs;
	}

	async scan(options: ScanOptions): Promise<string[]> {
		return await this.scanUnique(
			options,
			(path, extensions, maxDepth, signal) => DirUtils.scanFiles(path, extensions, maxDepth, signal),
			(filePath) => filePath,
			(_entry, resolvedPath) => resolvedPath,
		);
	}

	async scanWithStats(options: ScanOptions): Promise<ScannedFileEntry[]> {
		return await this.scanUnique(
			options,
			(path, extensions, maxDepth, signal) => DirUtils.scanFilesWithStats(path, extensions, maxDepth, signal),
			(entry) => entry.filePath,
			(entry, filePath) => ({ ...entry, filePath }),
		);
	}

	/** Shared scan → ignore-filter → resolve/dedupe pass for both scan shapes. */
	private async scanUnique<T>(
		options: ScanOptions,
		scanRoot: (path: string, extensions: readonly string[], maxDepth: number, signal: AbortSignal | undefined) => Promise<T[]>,
		pathOf: (entry: T) => string,
		withResolvedPath: (entry: T, filePath: string) => T,
	): Promise<T[]> {
		const { paths, extensions, maxDepth, signal } = resolveScanOptions(options);
		const scanned = await PromiseUtils.mapConcurrent(
			paths,
			systemResourcesService.getScannerConcurrency(),
			async (path) => {
				// Patterns are cloned on every serverConfig read — resolve once per
				// root instead of once per file.
				const patterns = serverConfig.media.ignorePatterns;
				// The timeout signal stops the real glob; the race below guarantees the
				// scan moves on even if the filesystem call ignores the abort.
				const timeoutSignal = AbortSignal.timeout(this.pathScanTimeoutMs);
				const scanSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
				const scanPromise = scanRoot(path, extensions, maxDepth, scanSignal);

				try {
					return (await PromiseUtils.withTimeout(scanPromise, this.pathScanTimeoutMs, `Library path scan ${path}`)).filter(
						(entry) => !isIgnoredPath(pathOf(entry), path, patterns),
					);
				} catch (error) {
					// The caller's abort must propagate; a per-path timeout only skips
					// this path (the scan itself is expected to wind down via scanSignal).
					if (error instanceof PromiseTimeoutError && !signal?.aborted) {
						this.logger.error("Library path scan timed out — skipping the path for this run", {
							path,
							timeoutMs: this.pathScanTimeoutMs,
						});

						return [];
					}

					throw error;
				}
			},
			signal,
		);

		const seen = new Set<string>();
		const unique: T[] = [];
		for (const entries of scanned) {
			for (const entry of entries) {
				const resolvedPath = PathUtils.resolve(pathOf(entry));
				if (seen.has(resolvedPath)) continue;

				seen.add(resolvedPath);
				unique.push(withResolvedPath(entry, resolvedPath));
			}
		}

		return unique;
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

/**
 * Roots repeat across every file of a scan; normalizing the same root per file
 * is wasted string work. Bounded because roots come from config (a handful).
 */
const normalizedRootCache = new Map<string, string>();
const MAX_NORMALIZED_ROOTS = 32;

function normalizeIgnoreRoot(rootPath: string): string {
	const cached = normalizedRootCache.get(rootPath);
	if (cached !== undefined) return cached;

	const normalized = rootPath.replaceAll("\\", "/").replace(TRAILING_SLASHES_REGEX, "").toLowerCase();
	if (normalizedRootCache.size >= MAX_NORMALIZED_ROOTS) normalizedRootCache.clear();
	normalizedRootCache.set(rootPath, normalized);

	return normalized;
}

export function matchesIgnorePattern(filePath: string, rootPath: string, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;

	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	const root = normalizeIgnoreRoot(rootPath);
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

function isIgnoredPath(filePath: string, rootPath: string, patterns: readonly string[]): boolean {
	if (EXTRA_FILE_NAME_PATTERN.test(PathUtils.getFileName(filePath))) return true;

	return matchesIgnorePattern(filePath, rootPath, patterns);
}

export const fileScannerService = new FileScannerService();
