import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { systemResourcesService } from "@/system/system-resources.service";
import { groupBy } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { detach, PromiseUtils } from "@/utils/promise.utils";
import { SidecarMetadataStorageService } from "./sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "./sidecar-metadata-writer.runtime";

/**
 * Re-writes sidecar documents after a metadata/season/episode mutation so
 * `sidecar` and `database_and_sidecar` storage modes stay in sync (previously
 * sidecars were only written once, at ingest).
 *
 * All media files of one title are passed in a single `saveLibraryMedia` call,
 * which is what makes its internal `savedSeries`/`savedSeasons` dedup apply —
 * the ingest path called it per file and lost the cross-file dedup.
 */
class SidecarSyncService extends BaseService {
	private readonly storage = new SidecarMetadataStorageService(sidecarMetadataWriter);
	/** In-flight sync per metadataId — a second request schedules one re-run instead of a parallel write. */
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly rerunRequested = new Set<string>();
	/** Bounds how many titles rewrite sidecars at once during a catalog-wide refresh. */
	private readonly semaphore = PromiseUtils.createSemaphore(() => systemResourcesService.getIoConcurrency());

	constructor() {
		super("SidecarSyncService");
	}

	/**
	 * Queues a sidecar rewrite for one title. Concurrent requests for the same
	 * title coalesce (one in-flight sync plus at most one re-run), and a global
	 * semaphore bounds parallelism: a catalog refresh used to fire one unbounded
	 * sync per title.
	 */
	scheduleSync(metadataId: string): void {
		if (this.inFlight.has(metadataId)) {
			// Data may change again while the current run reads — ask for one re-run.
			this.rerunRequested.add(metadataId);

			return;
		}

		const run = this.runQueued(metadataId);
		this.inFlight.set(metadataId, run);
		detach(run);
	}

	private async runQueued(metadataId: string): Promise<void> {
		try {
			await this.semaphore.run(() => this.syncForMetadata(metadataId));
		} catch (error) {
			this.logger.warn("Sidecar sync failed", { metadataId, error: errorMessage(error) });
		} finally {
			this.inFlight.delete(metadataId);
			if (this.rerunRequested.delete(metadataId)) this.scheduleSync(metadataId);
		}
	}

	async syncForMetadata(metadataId: string): Promise<void> {
		await this.safeExecute("syncForMetadata", async () => {
			const mediaFiles = await mediaRepository.findRootsByMetadataId(metadataId);
			if (mediaFiles.length === 0) return;

			const byLibrary = groupBy(mediaFiles, (mediaFile) => mediaFile.libraryId);
			for (const [libraryId, libraryMediaFiles] of byLibrary) {
				const library = await librariesRepository.findWithPaths(libraryId);
				if (!library) continue;

				await this.storage.saveLibraryMedia(
					library,
					libraryMediaFiles.map((mediaFile) => ({
						filePath: mediaFile.filePath,
						metadataId: mediaFile.metadataId,
						movieId: mediaFile.movieId,
						episodeId: mediaFile.episodeId,
					})),
				);
			}
		});
	}
}

export const sidecarSyncService = new SidecarSyncService();
