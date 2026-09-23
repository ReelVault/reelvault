import type { PluginEventInput } from "@sdk/plugin";
import { pluginsService } from "@/application/plugins.service";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";

interface ServiceDependencies {
	deleteByLibraryAndPaths: typeof mediaRepository.deleteByLibraryAndPathsAndGetCleanup;
	removeArtifactStorageFiles: (keys: string[]) => Promise<unknown>;
	deleteFile: (path: string) => Promise<boolean>;
	getIoConcurrency: () => number;
	subtitlesPath: () => string;
	clearLibraryStatsCache: () => void;
	emitMediaUnavailable: (input: PluginEventInput<"media.file.unavailable">) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
	deleteByLibraryAndPaths: (libraryId, paths) => mediaRepository.deleteByLibraryAndPathsAndGetCleanup(libraryId, paths),
	removeArtifactStorageFiles: (keys) => pluginsService.removeArtifactStorageFiles(keys),
	deleteFile: (path) => FileUtils.delete(path),
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
	subtitlesPath: () => serverConfig.paths.subtitles,
	clearLibraryStatsCache: () => librariesRepository.clearStatsCache(),
	emitMediaUnavailable: (input) => pluginsService.emit("media.file.unavailable", input),
};

/**
 * Purges database rows and sidecar artifacts for media files confirmed removed
 * from disk. Only subtitle artifacts under the configured subtitles root are
 * deleted — anything else stays untouched.
 */
export class StaleArtifactCleaner extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("StaleArtifactCleaner");
		this.dependencies = dependencies;
	}

	async cleanup(libraryId: string, removedFiles: string[], signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		this.logger.info(`Removing ${removedFiles.length} files no longer on disk`, { count: removedFiles.length });

		const {
			deleteByLibraryAndPaths,
			removeArtifactStorageFiles,
			deleteFile,
			getIoConcurrency,
			subtitlesPath,
			clearLibraryStatsCache,
			emitMediaUnavailable,
		} = this.dependencies;
		const cleanup = await deleteByLibraryAndPaths(libraryId, removedFiles);
		for (const removed of cleanup.removedMediaFiles) {
			await emitMediaUnavailable({ libraryId, mediaFileId: removed.id });
		}

		const removals: Array<() => Promise<unknown>> = [() => removeArtifactStorageFiles(cleanup.artifactStorageKeys)];
		for (const filePath of cleanup.subtitleFilePaths) {
			if (filePath && PathUtils.isSubpath(filePath, subtitlesPath())) {
				removals.push(() => deleteFile(filePath));
			}
		}

		for (const id of cleanup.subtitleIds) {
			removals.push(() => deleteFile(PathUtils.join(subtitlesPath(), `${id}.vtt`)));
		}

		await PromiseUtils.mapConcurrent(removals, getIoConcurrency(), (removal) => removal(), signal);
		clearLibraryStatsCache();
		this.logger.info("Removed stale media records", { libraryId, count: removedFiles.length });
	}
}

export const staleArtifactCleaner = new StaleArtifactCleaner();
