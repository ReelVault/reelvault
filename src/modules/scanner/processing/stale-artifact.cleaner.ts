import { join } from "node:path";
import type { PluginEventInput } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { deleteFile } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { isSubpath } from "@/utils/path.utils";
import { mapConcurrent } from "@/utils/promise.utils";

/** The cleaner's boundaries: the plugin event sink, the subtitles root and the host I/O budget. */
interface ServiceDependencies {
	getIoConcurrency: () => number;
	subtitlesPath: () => string;
	emitMediaUnavailable: (input: PluginEventInput<"media.file.unavailable">) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
	subtitlesPath: () => serverConfig.paths.subtitles,
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

		const { getIoConcurrency, subtitlesPath, emitMediaUnavailable } = this.dependencies;
		const cleanup = await mediaRepository.deleteByLibraryAndPathsAndGetCleanup(libraryId, removedFiles);
		// One event per removed file; awaiting each plugin handler in sequence
		// multiplies hook timeouts across large removals.
		await mapConcurrent(
			cleanup.removedMediaFiles,
			getIoConcurrency(),
			(removed) => emitMediaUnavailable({ libraryId, mediaFileId: removed.id }),
			signal,
		);

		const subtitlesRoot = subtitlesPath();
		const removals: Array<() => Promise<unknown>> = [() => mediaArtifactsService.removeStorageFiles(cleanup.artifactStorageKeys)];
		for (const filePath of cleanup.subtitleFilePaths) {
			if (filePath && isSubpath(filePath, subtitlesRoot)) {
				removals.push(() => deleteFile(filePath));
			}
		}

		for (const id of cleanup.subtitleIds) {
			removals.push(() => deleteFile(join(subtitlesRoot, `${id}.vtt`)));
		}

		await mapConcurrent(removals, getIoConcurrency(), (removal) => removal(), signal);
		mediaArtifactsService.invalidateByteTotals();
		librariesRepository.clearStatsCache();
		this.logger.info("Removed stale media records", { libraryId, count: removedFiles.length });
	}
}

export const staleArtifactCleaner = new StaleArtifactCleaner();
