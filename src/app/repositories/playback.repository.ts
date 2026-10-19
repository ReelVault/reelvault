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
	findWatchStateBulkData,
	upsertProgress,
	upsertProgressBulk,
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

	findPlaybackProgressAndSmartPlayData(metadataId: string, profileId: string) {
		return findPlaybackProgressAndSmartPlayData(metadataId, profileId);
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

	/** Bulk watch-state source data: files and the profile's progress in one statement per chunk. */
	findWatchStateBulkData(profileId: string, fileIds: readonly string[]) {
		return findWatchStateBulkData(profileId, fileIds);
	}

	upsertProgress(input: Parameters<typeof upsertProgress>[0]) {
		return upsertProgress(input);
	}

	upsertProgressBulk(input: Parameters<typeof upsertProgressBulk>[0]) {
		return upsertProgressBulk(input);
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
