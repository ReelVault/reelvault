import type { MetadataType } from "@reelvault/sdk/common";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { findContinueWatchingData } from "./playback/continue-watching.reader";
import {
	deleteMetadataProgress,
	deleteProgress,
	deleteProgressForFiles,
	dismissContinueWatching,
	findExistingMediaFileIds,
	findMediaFileWithMetadata,
	findProgressUpdateData,
	findViewerProfilesByMetadataId,
	hasActiveTitleProgress,
	upsertProgress,
} from "./playback/progress.repository";
import {
	findPlaybackProgressAndSmartPlayData,
	findProgressRows,
	findSmartPlayBatchData,
	findSmartPlayData,
} from "./playback/smart-play.reader";

class PlaybackRepository {
	/** Distinct profiles that have watched any file of this metadata row. */
	findViewerProfilesByMetadataId(metadataId: string) {
		return findViewerProfilesByMetadataId(metadataId);
	}

	findProgressRows(metadataId: string, profileId: string) {
		return findProgressRows(metadataId, profileId);
	}

	findPlaybackProgressAndSmartPlayData(metadataId: string, profileId: string, metadataType?: MetadataType) {
		return findPlaybackProgressAndSmartPlayData(metadataId, profileId, metadataType);
	}

	findSmartPlayData(metadataId: string, profileId: string) {
		return findSmartPlayData(metadataId, profileId);
	}

	/**
	 * Batched smart-play source data for a card grid (bounded id list, ≤50).
	 * Replaces the per-id `findSmartPlayData` fan-out; see {@link findSmartPlayBatchData}.
	 */
	findSmartPlayBatchData(metadataIds: readonly string[], profileId: string) {
		return findSmartPlayBatchData(metadataIds, profileId);
	}

	findProgressUpdateData(fileId: string, profileId: string) {
		return findProgressUpdateData(fileId, profileId);
	}

	/** Whether any in-progress file of this title has watched progress past `minPositionSeconds`. */
	hasActiveTitleProgress(profileId: string, metadataId: string, minPositionSeconds: number): Promise<boolean> {
		return hasActiveTitleProgress(profileId, metadataId, minPositionSeconds);
	}

	upsertProgress(input: Parameters<typeof upsertProgress>[0]) {
		return upsertProgress(input);
	}

	deleteProgress(profileId: string, fileId: string, tx?: DatabaseTransaction) {
		return deleteProgress(profileId, fileId, tx);
	}

	deleteProgressForFiles(profileId: string, fileIds: readonly string[], tx?: DatabaseTransaction) {
		return deleteProgressForFiles(profileId, fileIds, tx);
	}

	/** The ids among `fileIds` that exist as media files. */
	findExistingMediaFileIds(fileIds: readonly string[]): Promise<Set<string>> {
		return findExistingMediaFileIds(fileIds);
	}

	findMediaFileWithMetadata(fileId: string) {
		return findMediaFileWithMetadata(fileId);
	}

	/** Hides a title from "Continue watching" without touching resume positions. */
	dismissContinueWatching(profileId: string, metadataId: string) {
		return dismissContinueWatching(profileId, metadataId);
	}

	deleteMetadataProgress(profileId: string, metadataId: string, tx?: DatabaseTransaction) {
		return deleteMetadataProgress(profileId, metadataId, tx);
	}

	findContinueWatchingData(profileId: string, limit = 24) {
		return findContinueWatchingData(profileId, limit);
	}
}

export const playbackRepository = new PlaybackRepository();
