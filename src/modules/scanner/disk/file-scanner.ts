import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils, type ScannedFileEntry } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import type { FilePathChanges } from "../scanner.types";
import { compareFilePaths, filterPathsWithinRoots } from "../utils/scanner.utils";

class FileScannerService extends BaseService {
	constructor() {
		super("FileScannerService");
	}

	async scan({
		paths,
		extensions = serverConfig.media.supportedVideoExtensions,
		maxDepth = 10,
		signal,
	}: {
		paths: string[];
		extensions?: readonly string[] | undefined;
		maxDepth?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<string[]> {
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

	async scanWithStats({
		paths,
		extensions = serverConfig.media.supportedVideoExtensions,
		maxDepth = 10,
		signal,
	}: {
		paths: string[];
		extensions?: readonly string[] | undefined;
		maxDepth?: number | undefined;
		signal?: AbortSignal | undefined;
	}): Promise<ScannedFileEntry[]> {
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

export function matchesIgnorePattern(filePath: string, rootPath: string, patterns: readonly string[]): boolean {
	if (patterns.length === 0) return false;

	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	const root = rootPath.replaceAll("\\", "/").replace(TRAILING_SLASHES_REGEX, "").toLowerCase();
	const relative = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;

	return patterns.some((pattern) => {
		const trimmed = pattern.trim().toLowerCase();
		if (!trimmed) return false;

		const escaped = trimmed
			.replaceAll(/[\\+(){}[\]$^|.]/g, "\\$&")
			.replaceAll("*", "\u0000")
			.replaceAll("?", "\u0001")
			.replaceAll("\u0000", ".*")
			.replaceAll("\u0001", ".");
		const regex = new RegExp(`^${escaped}$`);

		// Name-only patterns match any path segment, so ignoring a folder name
		// skips everything inside it; separator-bearing patterns match the
		// scan-relative path.
		if (escaped.includes("/")) return regex.test(relative);

		return relative.split("/").some((segment) => regex.test(segment));
	});
}

function isIgnoredPath(filePath: string, rootPath: string): boolean {
	return matchesIgnorePattern(filePath, rootPath, serverConfig.media.ignorePatterns);
}

export const fileScannerService = new FileScannerService();
