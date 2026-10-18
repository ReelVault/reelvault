import type { PluginEventInput } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { type ScannerStoragePort, scannerStorage } from "@/modules/scanner/scanner.ports";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

interface ServiceDependencies {
	deleteByLibraryAndPaths: ScannerStoragePort["deleteByLibraryAndPaths"];
	removeArtifactStorageFiles: ScannerStoragePort["removeArtifactStorageFiles"];
	invalidateArtifactByteTotals: ScannerStoragePort["invalidateArtifactByteTotals"];
	deleteFile: (path: string) => Promise<boolean>;
	getIoConcurrency: () => number;
	subtitlesPath: () => string;
	clearLibraryStatsCache: ScannerStoragePort["clearLibraryStatsCache"];
	emitMediaUnavailable: (input: PluginEventInput<"media.file.unavailable">) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
	deleteByLibraryAndPaths: (libraryId, paths) => scannerStorage().deleteByLibraryAndPaths(libraryId, paths),
	removeArtifactStorageFiles: (keys) => scannerStorage().removeArtifactStorageFiles(keys),
	invalidateArtifactByteTotals: () => scannerStorage().invalidateArtifactByteTotals(),
	deleteFile: (path) => FileUtils.delete(path),
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
	subtitlesPath: () => serverConfig.paths.subtitles,
	clearLibraryStatsCache: () => scannerStorage().clearLibraryStatsCache(),
	emitMediaUnavailable: (input) => pluginEventBus.emit("media.file.unavailable", input),
};

/**
 * Purges database rows and sidecar artifacts for media files confirmed removed
 * from disk. Only subtitle artifacts under the configured subtitles root are
 * deleted — anything else stays untouched.
 */
export class StaleArtifactCleaner {
	readonly serviceName = "StaleArtifactCleaner";
	readonly logger = createLogger("StaleArtifactCleaner");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async cleanup(libraryId: string, removedFiles: string[], signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		this.logger.info(`Removing ${removedFiles.length} files no longer on disk`, { count: removedFiles.length });

		const {
			deleteByLibraryAndPaths,
			removeArtifactStorageFiles,
			invalidateArtifactByteTotals,
			deleteFile,
			getIoConcurrency,
			subtitlesPath,
			clearLibraryStatsCache,
			emitMediaUnavailable,
		} = this.dependencies;
		const cleanup = await deleteByLibraryAndPaths(libraryId, removedFiles);
		// One event per removed file; awaiting each plugin handler in sequence
		// multiplies hook timeouts across large removals.
		await PromiseUtils.mapConcurrent(
			cleanup.removedMediaFiles,
			getIoConcurrency(),
			(removed) => emitMediaUnavailable({ libraryId, mediaFileId: removed.id }),
			signal,
		);

		const subtitlesRoot = subtitlesPath();
		const removals: Array<() => Promise<unknown>> = [() => removeArtifactStorageFiles(cleanup.artifactStorageKeys)];
		for (const filePath of cleanup.subtitleFilePaths) {
			if (filePath && PathUtils.isSubpath(filePath, subtitlesRoot)) {
				removals.push(() => deleteFile(filePath));
			}
		}

		for (const id of cleanup.subtitleIds) {
			removals.push(() => deleteFile(PathUtils.join(subtitlesRoot, `${id}.vtt`)));
		}

		await PromiseUtils.mapConcurrent(removals, getIoConcurrency(), (removal) => removal(), signal);
		invalidateArtifactByteTotals();
		clearLibraryStatsCache();
		this.logger.info("Removed stale media records", { libraryId, count: removedFiles.length });
	}
}

export const staleArtifactCleaner = new StaleArtifactCleaner();
