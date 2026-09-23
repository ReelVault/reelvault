import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { groupBy } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { detach } from "@/utils/promise.utils";
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

	constructor() {
		super("SidecarSyncService");
	}

	/** Fire-and-forget variant that never surfaces an unhandled rejection. */
	scheduleSync(metadataId: string): void {
		detach(this.runSyncSafely(metadataId));
	}

	private async runSyncSafely(metadataId: string): Promise<void> {
		try {
			await this.syncForMetadata(metadataId);
		} catch (error) {
			this.logger.warn("Sidecar sync failed", { metadataId, error: errorMessage(error) });
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
