import type {
	BatchSmartPlayResponse,
	ContinueWatchingItem,
	MetadataPlaybackProgress,
	StreamPrefs,
	UpdatePlaybackProgress,
	WatchStateBulk,
	WatchStateBulkResult,
	WatchStateScope,
} from "@reelvault/sdk/common";
import type { PlaybackProgressComputeData, SmartPlay, SmartPlayComputeData } from "@/modules/streaming/streaming.types";
import { isCompleted, normalizePlaybackPosition } from "@/modules/streaming/utils/playback-position.utils";
import { playbackRepository as defaultPlaybackRepository } from "@/repositories/playback.repository";
import { profilePreferencesRepository as defaultProfilePreferencesRepository } from "@/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository as defaultProfileStreamPrefsRepository } from "@/repositories/profile-stream-prefs.repository";
import { type DatabaseTransaction, unitOfWorkRepository } from "@/repositories/unit-of-work.repository";
import { watchedHistoryRepository as defaultWatchedHistoryRepository } from "@/repositories/watched-history.repository";
import { watchlistRepository as defaultWatchlistRepository } from "@/repositories/watchlist.repository";
import { invalidateProfileCaches } from "@/services/users/cache-invalidation.cache";
import { trimAndFilter, unique } from "@/utils/array.utils";
import { assertFound, assertProfileId, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { invalidateProfileResponseBodies } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { buildContinueWatching } from "./continue-watching.builder";
import { computePlaybackProgress, computeSmartPlay } from "./playback-progress.aggregator";
import { PlaybackProgressPublisher } from "./playback-progress.publisher";
import { selectNextEpisodeFileInSeries } from "./smart-play.resolver";

export type PlaybackProgressRepo = Pick<
	typeof defaultPlaybackRepository,
	| "findProgressUpdateData"
	| "findWatchStateBulkData"
	| "upsertProgress"
	| "upsertProgressBulk"
	| "findMediaFileWithMetadata"
	| "findContinueWatchingData"
	| "findPlaybackProgressAndSmartPlayData"
	| "findSmartPlayData"
	| "findSmartPlayBatchData"
	| "deleteProgress"
	| "deleteMetadataProgress"
	| "deleteProgressForFiles"
	| "findExistingMediaFileIds"
	| "dismissContinueWatching"
>;

export type WatchedHistoryRepo = Pick<typeof defaultWatchedHistoryRepository, "recordPlay" | "recordPlays">;
export type WatchlistRepo = Pick<typeof defaultWatchlistRepository, "findWatchlistedIds" | "remove">;

/** Hard cap for the batch smart-play endpoint (guards giant query strings). */
const MAX_BATCH_IDS = 50;

/** One file prepared for the bulk watch-state write. */
interface BulkWatchUpdate {
	fileId: string;
	metadataId: string;
	duration: number;
	position: number;
	completed: boolean;
	audioStreamIndex: number | null;
	subtitleId: string | null;
	/** A play row is written only when the file was not already marked watched. */
	recordsPlay: boolean;
}

export type ProfileStreamPrefsRepo = Pick<typeof defaultProfileStreamPrefsRepository, "upsert" | "findForTitle" | "findByMediaFile">;

export interface ProfilePreferencesRepo {
	getEffective(input: { profileId: string }): Promise<{ continueWatchingMinutes: number; watchlistAutoRemoveWatched: boolean }>;
}

export interface PlaybackProgressPublisherDependency {
	publishUpdate(event: Parameters<PlaybackProgressPublisher["publishUpdate"]>[0]): void;
}

/** Runs the writes of one logical update in a single database transaction. */
export type RunTransaction = <T>(work: (tx: DatabaseTransaction | undefined) => Promise<T>) => Promise<T>;

export interface ServiceDependencies {
	playbackRepository: PlaybackProgressRepo;
	watchedHistoryRepository: WatchedHistoryRepo;
	profileStreamPrefsRepository: ProfileStreamPrefsRepo;
	profilePreferencesRepository: ProfilePreferencesRepo;
	watchlistRepository: WatchlistRepo;
	publisher: PlaybackProgressPublisherDependency;
	runTransaction: RunTransaction;
}

const defaultDependencies: ServiceDependencies = {
	playbackRepository: defaultPlaybackRepository,
	watchedHistoryRepository: defaultWatchedHistoryRepository,
	profileStreamPrefsRepository: defaultProfileStreamPrefsRepository,
	profilePreferencesRepository: defaultProfilePreferencesRepository,
	watchlistRepository: defaultWatchlistRepository,
	publisher: new PlaybackProgressPublisher(),
	runTransaction: (work) => unitOfWorkRepository.run(work),
};

/** Normalizes a stream-track language: blank values clear the stored preference. */
function normalizeStreamPrefLanguage(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";

	return trimmed.length > 0 ? trimmed : null;
}

/** The position and completion state a progress write resolves to. */
function resolveProgressState(body: UpdatePlaybackProgress, duration: number): { position: number; completed: boolean } {
	// "Mark watched" writes MAX_SAFE_INTEGER; a file with no known duration
	// cannot satisfy the ratio check, so honor the explicit intent instead of
	// storing a bogus position and leaving the row incomplete.
	const requestedPosition = body.position ?? 0;
	const explicitComplete = requestedPosition >= Number.MAX_SAFE_INTEGER && duration <= 0;
	const position = explicitComplete ? 0 : normalizePlaybackPosition(requestedPosition, duration);

	return { position, completed: explicitComplete || isCompleted(position, duration) };
}

class PlaybackProgressService {
	readonly serviceName = "PlaybackProgressService";
	readonly logger = createLogger("PlaybackProgressService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async updatePlaybackProgress(fileId: string, body: UpdatePlaybackProgress, profileId?: string): Promise<{ success: true }> {
		return await runSafely(this, "updatePlaybackProgress", async () => {
			const { playbackRepository, watchedHistoryRepository, publisher, runTransaction } = this.dependencies;
			assertProfileId(profileId);
			const { mediaFile, existingProgress } = await playbackRepository.findProgressUpdateData(fileId, profileId);
			assertFound(mediaFile, "MediaFile", fileId);

			const duration = mediaFile.duration ?? 0;
			const { position, completed } = resolveProgressState(body, duration);
			const audioStreamIndex = body.audioStreamIndex === undefined ? existingProgress?.audioStreamIndex : body.audioStreamIndex;
			const subtitleId = body.subtitleId === undefined ? existingProgress?.subtitleId : body.subtitleId;
			const completesTitle = completed && !existingProgress?.completed;

			// The progress row and the history row are one unit: if the history write fails, the progress must not
			// stay marked completed, or a retry would see "already completed" and never record the play.
			await runTransaction(async (tx) => {
				await playbackRepository.upsertProgress({
					profileId,
					fileId,
					position,
					duration,
					completed,
					audioStreamIndex,
					subtitleId,
					tx,
				});

				if (completesTitle) {
					await watchedHistoryRepository.recordPlay(
						{
							profileId,
							mediaFileId: fileId,
							durationWatched: position,
							isFullWatch: true,
						},
						tx,
					);
				}
			});

			if (completesTitle) {
				await this.removeWatchedTitleFromWatchlist(profileId, mediaFile.metadataId);
				// A finished title changes recommendations, insights and "wrapped" — their caches are per profile.
				invalidateProfileCaches(profileId);
			}

			// Language-level choices carry over to the whole title/series (movies and
			// episodes share the same metadataId); undefined = not touched this update.
			if (body.audioLanguage !== undefined || body.subtitleLanguage !== undefined) {
				await this.dependencies.profileStreamPrefsRepository.upsert({
					profileId,
					metadataId: mediaFile.metadataId,
					audioLanguage: body.audioLanguage === undefined ? undefined : normalizeStreamPrefLanguage(body.audioLanguage),
					subtitleLanguage: body.subtitleLanguage === undefined ? undefined : normalizeStreamPrefLanguage(body.subtitleLanguage),
				});
			}

			publisher.publishUpdate({
				profileId,
				mediaFileId: fileId,
				position,
				duration,
				completed,
				audioStreamIndex,
				subtitleId,
			});

			// Continue-watching / detail user-state bodies for this profile are now stale.
			invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}

	/** Language preferences saved for the title/series this file belongs to (for pre-selecting tracks on the next episode). */
	async getStreamPrefs(fileId: string, profileId?: string): Promise<StreamPrefs | null> {
		return await runSafely(this, "getStreamPrefs", async () => {
			assertProfileId(profileId);
			// One LEFT JOIN resolves file→metadata→prefs (was two chained selects).
			const resolved = await this.dependencies.profileStreamPrefsRepository.findByMediaFile(fileId, profileId);
			assertFound(resolved, "MediaFile", fileId);

			return resolved.prefs;
		});
	}

	/** Takes a title off the watchlist once it is watched, when the profile has asked for that. */
	private async removeWatchedTitleFromWatchlist(profileId: string, metadataId: string): Promise<void> {
		const { profilePreferencesRepository, watchlistRepository } = this.dependencies;
		const preferences = await profilePreferencesRepository.getEffective({ profileId });
		if (!preferences.watchlistAutoRemoveWatched) return;

		const progress = await this.getPlaybackProgress(metadataId, profileId);
		if (progress.status !== "watched") return;

		await watchlistRepository.remove(profileId, metadataId);
		invalidateProfileResponseBodies(profileId);
	}

	async dismissContinueWatching(metadataId: string, profileId?: string): Promise<{ success: true }> {
		return await runSafely(this, "dismissContinueWatching", async () => {
			assertProfileId(profileId);
			await this.dependencies.playbackRepository.dismissContinueWatching(profileId, metadataId);
			invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}

	/**
	 * Marks files watched (finished, exactly as the single update would) or
	 * unwatched (their progress rows are removed). Every id is checked before
	 * anything is written, so an unknown id changes nothing. The watched path
	 * writes all rows and their history entries in one transaction: a 500-id
	 * batch is a handful of statements, not one round trip per file.
	 */
	async setWatchStateBulk(body: WatchStateBulk, profileId?: string): Promise<WatchStateBulkResult> {
		return await runSafely(this, "setWatchStateBulk", async () => {
			assertProfileId(profileId);
			const fileIds = unique(body.mediaFileIds);

			if (body.watched) await this.applyBulkWatchState(fileIds, profileId);
			else await this.applyBulkUnwatchState(fileIds, profileId);

			invalidateProfileResponseBodies(profileId);

			return { updated: fileIds.length };
		});
	}

	/** The watched half of {@link setWatchStateBulk}: one read, one transaction, one title check per title. */
	private async applyBulkWatchState(fileIds: string[], profileId: string): Promise<void> {
		const { playbackRepository, watchedHistoryRepository, runTransaction, publisher } = this.dependencies;
		const updates = await this.prepareBulkWatchUpdates(fileIds, profileId);

		await runTransaction(async (tx) => {
			await playbackRepository.upsertProgressBulk({ profileId, rows: updates, tx });
			await watchedHistoryRepository.recordPlays(
				updates
					.filter((update) => update.recordsPlay)
					.map((update) => ({
						profileId,
						mediaFileId: update.fileId,
						durationWatched: update.position,
						isFullWatch: true,
					})),
				tx,
			);
		});

		for (const update of updates) {
			publisher.publishUpdate({
				profileId,
				mediaFileId: update.fileId,
				position: update.position,
				duration: update.duration,
				completed: update.completed,
				audioStreamIndex: update.audioStreamIndex,
				subtitleId: update.subtitleId,
			});
		}

		// One title check per affected title instead of one per file.
		const touchedTitles = unique(updates.filter((update) => update.recordsPlay).map((update) => update.metadataId));
		for (const metadataId of touchedTitles) {
			await this.removeWatchedTitleFromWatchlist(profileId, metadataId);
		}
		// A finished title changes recommendations, insights and "wrapped".
		if (touchedTitles.length > 0) invalidateProfileCaches(profileId);
	}

	/** Files and the profile's saved rows in one read; the first unknown id throws `entity.not_found`. */
	private async prepareBulkWatchUpdates(fileIds: string[], profileId: string): Promise<BulkWatchUpdate[]> {
		const rows = await this.dependencies.playbackRepository.findWatchStateBulkData(profileId, fileIds);
		const rowsById = new Map(rows.map((row) => [row.id, row] as const));

		const updates: BulkWatchUpdate[] = [];
		for (const fileId of fileIds) {
			const row = rowsById.get(fileId);
			if (!row) {
				throw new DomainError("not_found", `MediaFile not found: ${fileId}`, {
					code: "entity.not_found",
					params: { entityType: "MediaFile", entityId: fileId },
				});
			}

			// "Mark watched" writes MAX_SAFE_INTEGER; a file with no known duration
			// cannot satisfy the ratio check, so the explicit intent stores position
			// 0 instead of a bogus value (the single-update rule).
			const duration = row.duration ?? 0;
			const explicitComplete = duration <= 0;
			const position = explicitComplete ? 0 : normalizePlaybackPosition(Number.MAX_SAFE_INTEGER, duration);
			updates.push({
				fileId,
				metadataId: row.metadataId,
				duration,
				position,
				completed: explicitComplete || isCompleted(position, duration),
				audioStreamIndex: row.audioStreamIndex,
				subtitleId: row.subtitleId,
				recordsPlay: row.completed !== true,
			});
		}

		return updates;
	}

	/** The unwatched half of {@link setWatchStateBulk}: precheck every id, then one delete. */
	private async applyBulkUnwatchState(fileIds: string[], profileId: string): Promise<void> {
		const { playbackRepository } = this.dependencies;
		const existing = await playbackRepository.findExistingMediaFileIds(fileIds);
		const missing = fileIds.find((fileId) => !existing.has(fileId));
		if (missing !== undefined) {
			throw new DomainError("not_found", `MediaFile not found: ${missing}`, {
				code: "entity.not_found",
				params: { entityType: "MediaFile", entityId: missing },
			});
		}

		await playbackRepository.deleteProgressForFiles(profileId, fileIds);
	}

	/** `scope: "file"` resets only this file; `"title"` resets every file of its title (all versions, all episodes of a series). */
	async resetPlaybackProgress(fileId: string, profileId?: string, scope: WatchStateScope = "title"): Promise<{ success: true }> {
		return await runSafely(this, "resetPlaybackProgress", async () => {
			const { playbackRepository } = this.dependencies;
			assertProfileId(profileId);
			const mediaFile = await playbackRepository.findMediaFileWithMetadata(fileId);
			if (scope === "title" && mediaFile?.metadataId) {
				await playbackRepository.deleteMetadataProgress(profileId, mediaFile.metadataId);
			} else {
				await playbackRepository.deleteProgress(profileId, fileId);
			}

			invalidateProfileResponseBodies(profileId);

			return { success: true };
		});
	}

	computePlaybackProgress(data: PlaybackProgressComputeData): MetadataPlaybackProgress {
		return computePlaybackProgress(data);
	}

	computeSmartPlay(data: SmartPlayComputeData): SmartPlay {
		return computeSmartPlay(data);
	}

	/**
	 * Progress and smart play of one title, plus — when the caller names the
	 * episode it is showing — the file of the episode that follows it. The
	 * follow-up comes from the same load, so the playback view needs no second
	 * read for its "next episode" suggestion.
	 */
	async getPlaybackOverview(
		metadataId: string,
		profileId?: string,
		currentEpisode?: { id: string; seasonId: string },
	): Promise<{ progress: MetadataPlaybackProgress; smartPlay: SmartPlay; nextEpisodeFileId: string | null }> {
		return await runSafely(this, "getPlaybackOverview", async () => {
			const data = await this.loadTitleProgressData(metadataId, profileId, (resolvedProfileId) =>
				this.dependencies.playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, resolvedProfileId),
			);

			let nextEpisodeFileId: string | null = null;
			if (currentEpisode) {
				nextEpisodeFileId = selectNextEpisodeFileInSeries(data.episodes, data.seasons, data.mediaFiles, currentEpisode);
			}

			return {
				progress: computePlaybackProgress(data),
				smartPlay: computeSmartPlay(data),
				nextEpisodeFileId,
			};
		});
	}

	async getPlaybackProgress(metadataId: string, profileId?: string): Promise<MetadataPlaybackProgress> {
		return await runSafely(this, "getPlaybackProgress", async () => {
			const data = await this.loadTitleProgressData(metadataId, profileId, (resolvedProfileId) =>
				this.dependencies.playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, resolvedProfileId),
			);

			return computePlaybackProgress(data);
		});
	}

	async getContinueWatching(profileId?: string, limit = 12): Promise<{ data: ContinueWatchingItem[] }> {
		return await runSafely(this, "getContinueWatching", async () => {
			const { playbackRepository } = this.dependencies;
			assertProfileId(profileId);
			const data = await playbackRepository.findContinueWatchingData(profileId, limit);
			const preferences = await this.dependencies.profilePreferencesRepository.getEffective({ profileId });

			return { data: buildContinueWatching(data, limit, preferences.continueWatchingMinutes * 60) };
		});
	}

	async getSmartPlay(metadataId: string, profileId?: string): Promise<SmartPlay> {
		return await runSafely(this, "getSmartPlay", async () => {
			const data = await this.loadTitleProgressData(metadataId, profileId, (resolvedProfileId) =>
				this.dependencies.playbackRepository.findSmartPlayData(metadataId, resolvedProfileId),
			);

			return computeSmartPlay({
				metadata: data.metadata,
				mediaFiles: data.mediaFiles,
				progressRows: data.progress,
				seasons: data.seasons,
				episodes: data.episodes,
			});
		});
	}

	/** Shared title-progress load: active profile, repository fetch and existence check. */
	private async loadTitleProgressData<T>(
		metadataId: string,
		profileId: string | undefined,
		load: (profileId: string) => Promise<T | null | undefined>,
	): Promise<T> {
		assertProfileId(profileId);
		const data = await load(profileId);
		assertFound(data, "Metadata", metadataId);

		return data;
	}

	/** Batch smart play + watchlist flags — one request for a whole grid of cards. */
	async getSmartPlayBatch(metadataIds: string[], profileId?: string): Promise<BatchSmartPlayResponse> {
		return await runSafely(this, "getSmartPlayBatch", async () => {
			assertProfileId(profileId);
			const ids = unique(trimAndFilter(metadataIds)).slice(0, MAX_BATCH_IDS);
			if (ids.length === 0) return { suggestions: [] };

			// The batch statement carries the watchlist flags for the same id list.
			// Only a failed batch falls back to the separate watchlist read, so an
			// outage still reports flags for suggestion-less cards (previous behavior).
			const batch = await this.dependencies.playbackRepository.findSmartPlayBatchData(ids, profileId).catch(() => null);
			let watchlisted: Set<string>;
			if (batch) {
				watchlisted = new Set(batch.filter((entry) => entry.inWatchlist).map((entry) => entry.metadataId));
			} else {
				watchlisted = await this.dependencies.watchlistRepository.findWatchlistedIds(profileId, ids).catch(() => new Set<string>());
			}
			const suggestionByMetadataId = new Map(
				(batch ?? []).map((entry) => [entry.metadataId, entry.data ? computeSmartPlay(entry.data).suggestion : null]),
			);

			return {
				suggestions: ids.map((metadataId) => ({
					metadataId,
					suggestion: suggestionByMetadataId.get(metadataId) ?? null,
					inWatchlist: watchlisted.has(metadataId),
				})),
			};
		});
	}
}

export const playbackProgressService = new PlaybackProgressService();

export { PlaybackProgressService };
