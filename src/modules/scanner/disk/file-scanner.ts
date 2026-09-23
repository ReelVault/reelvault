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
			(path) => DirUtils.scanFiles(path, extensions, maxDepth, signal),
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
			(path) => DirUtils.scanFilesWithStats(path, extensions, maxDepth, signal),
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

export const fileScannerService = new FileScannerService();
