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

export const playbackRepository = {
	/** Distinct profiles that have watched any file of this metadata row. */
	findViewerProfilesByMetadataId,
	findProgressRows,
	findPlaybackProgressAndSmartPlayData,
	findSmartPlayData,
	/**
	 * Batched smart-play source data for a card grid (bounded id list, ≤50).
	 * Replaces the per-id `findSmartPlayData` fan-out; see {@link findSmartPlayBatchData}.
	 */
	findSmartPlayBatchData,
	findProgressUpdateData,
	/** Bulk watch-state source data: files and the profile's progress in one statement per chunk. */
	findWatchStateBulkData,
	upsertProgress,
	upsertProgressBulk,
	deleteProgress,
	deleteProgressForFiles,
	/** The ids among `fileIds` that exist as media files. */
	findExistingMediaFileIds,
	findMediaFileWithMetadata,
	/** Hides a title from "Continue watching" without touching resume positions. */
	dismissContinueWatching,
	deleteMetadataProgress,
	findContinueWatchingData: (profileId: string, limit = 24) => findContinueWatchingData(profileId, limit),
};
