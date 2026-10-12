import type {
	BatchSmartPlayResponse,
	ContinueWatchingItem,
	MetadataPlaybackProgress,
	MetadataType,
	StreamPrefs,
	UpdatePlaybackProgress,
	WatchStateBulk,
	WatchStateBulkResult,
	WatchStateScope,
} from "@reelvault/sdk/common";
import { invalidateProfileCaches } from "@/application/users/cache-invalidation";
import { playbackRepository as defaultPlaybackRepository } from "@/database/repositories/playback.repository";
import { profilePreferencesRepository as defaultProfilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository as defaultProfileStreamPrefsRepository } from "@/database/repositories/profile-stream-prefs.repository";
import { watchedHistoryRepository as defaultWatchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { watchlistRepository as defaultWatchlistRepository } from "@/database/repositories/watchlist.repository";
import { trimAndFilter, unique } from "@/utils/array.utils";
import { assertFound, assertProfileId, DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { invalidateProfileResponseBodies } from "@/utils/response-body-cache";
import { runSafely } from "@/utils/safe-execute";
import type { PlaybackProgressComputeData, SmartPlay, SmartPlayComputeData } from "../streaming.types";
import { isCompleted, normalizePlaybackPosition } from "../utils/playback-position.utils";
import { buildContinueWatching } from "./continue-watching.builder";
import { computePlaybackProgress, computeSmartPlay } from "./playback-progress.aggregator";
import { PlaybackProgressPublisher } from "./playback-progress.publisher";

export type PlaybackProgressRepo = Pick<
	typeof defaultPlaybackRepository,
	| "findProgressUpdateData"
	| "upsertProgress"
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

export type WatchedHistoryRepo = Pick<typeof defaultWatchedHistoryRepository, "sync">;
export type WatchlistRepo = Pick<typeof defaultWatchlistRepository, "findWatchlistedIds" | "remove">;

/** Hard cap for the batch smart-play endpoint (guards giant query strings). */
const MAX_BATCH_IDS = 50;

export type ProfileStreamPrefsRepo = Pick<typeof defaultProfileStreamPrefsRepository, "upsert" | "find" | "findByMediaFile">;

export interface ProfilePreferencesRepo {
	getEffective(input: { profileId: string }): Promise<{ continueWatchingMinutes: number; watchlistAutoRemoveWatched: boolean }>;
}

export interface PlaybackProgressPublisherDependency {
	publishUpdate(event: Parameters<PlaybackProgressPublisher["publishUpdate"]>[0]): void;
}

export interface ServiceDependencies {
	playbackRepository: PlaybackProgressRepo;
	watchedHistoryRepository: WatchedHistoryRepo;
	profileStreamPrefsRepository: ProfileStreamPrefsRepo;
	profilePreferencesRepository: ProfilePreferencesRepo;
	watchlistRepository: WatchlistRepo;
	publisher: PlaybackProgressPublisherDependency;
}

const defaultDependencies: ServiceDependencies = {
	playbackRepository: defaultPlaybackRepository,
	watchedHistoryRepository: defaultWatchedHistoryRepository,
	profileStreamPrefsRepository: defaultProfileStreamPrefsRepository,
	profilePreferencesRepository: defaultProfilePreferencesRepository,
	watchlistRepository: defaultWatchlistRepository,
	publisher: new PlaybackProgressPublisher(),
};

/** Normalizes a stream-track language: blank values clear the stored preference. */
function normalizeStreamPrefLanguage(value: string | null | undefined): string | null {
	const trimmed = value?.trim() ?? "";

	return trimmed.length > 0 ? trimmed : null;
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
			const { playbackRepository, watchedHistoryRepository, publisher } = this.dependencies;
			assertProfileId(profileId);
			const { mediaFile, existingProgress } = await playbackRepository.findProgressUpdateData(fileId, profileId);
			assertFound(mediaFile, "MediaFile", fileId);

			const duration = mediaFile.duration ?? 0;
			const position = normalizePlaybackPosition(body.position, duration);
			const completed = isCompleted(position, duration);
			const audioStreamIndex = body.audioStreamIndex !== undefined ? body.audioStreamIndex : existingProgress?.audioStreamIndex;
			const subtitleId = body.subtitleId !== undefined ? body.subtitleId : existingProgress?.subtitleId;

			await playbackRepository.upsertProgress({
				profileId,
				fileId,
				position,
				duration,
				completed,
				audioStreamIndex,
				subtitleId,
			});

			if (completed && !existingProgress?.completed) {
				await watchedHistoryRepository.sync({
					profileId,
					mediaFileId: fileId,
					durationWatched: position,
					isFullWatch: true,
				});
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
					audioLanguage: body.audioLanguage !== undefined ? normalizeStreamPrefLanguage(body.audioLanguage) : undefined,
					subtitleLanguage: body.subtitleLanguage !== undefined ? normalizeStreamPrefLanguage(body.subtitleLanguage) : undefined,
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
	 * Marks files watched (each goes through the single-update path, so completion and
	 * watch history match) or unwatched (their progress rows are removed). Every id is
	 * checked before anything is written, so an unknown id changes nothing.
	 */
	async setWatchStateBulk(body: WatchStateBulk, profileId?: string): Promise<WatchStateBulkResult> {
		return await runSafely(this, "setWatchStateBulk", async () => {
			const { playbackRepository } = this.dependencies;
			assertProfileId(profileId);

			const fileIds = unique(body.mediaFileIds);
			const existing = await playbackRepository.findExistingMediaFileIds(fileIds);
			const missing = fileIds.find((fileId) => !existing.has(fileId));
			if (missing !== undefined) {
				throw new DomainError("not_found", `MediaFile not found: ${missing}`, {
					code: "entity.not_found",
					params: { entityType: "MediaFile", entityId: missing },
				});
			}

			if (body.watched) {
				for (const fileId of fileIds) {
					await this.updatePlaybackProgress(fileId, { position: Number.MAX_SAFE_INTEGER }, profileId);
				}
			} else {
				await playbackRepository.deleteProgressForFiles(profileId, fileIds);
			}
			invalidateProfileResponseBodies(profileId);

			return { updated: fileIds.length };
		});
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

	async getPlaybackOverview(
		metadataId: string,
		profileId?: string,
		metadataType?: MetadataType,
	): Promise<{ progress: MetadataPlaybackProgress; smartPlay: SmartPlay }> {
		return await runSafely(this, "getPlaybackOverview", async () => {
			const data = await this.loadTitleProgressData(metadataId, profileId, (resolvedProfileId) =>
				this.dependencies.playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, resolvedProfileId, metadataType),
			);

			return {
				progress: computePlaybackProgress(data),
				smartPlay: computeSmartPlay(data),
			};
		});
	}

	async getPlaybackProgress(metadataId: string, profileId?: string, metadataType?: MetadataType): Promise<MetadataPlaybackProgress> {
		return await runSafely(this, "getPlaybackProgress", async () => {
			const data = await this.loadTitleProgressData(metadataId, profileId, (resolvedProfileId) =>
				this.dependencies.playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, resolvedProfileId, metadataType),
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

			const [batch, watchlisted] = await Promise.all([
				this.dependencies.playbackRepository.findSmartPlayBatchData(ids, profileId).catch(() => []),
				this.dependencies.watchlistRepository.findWatchlistedIds(profileId, ids).catch(() => new Set<string>()),
			]);
			const suggestionByMetadataId = new Map(
				batch.map((entry) => [entry.metadataId, entry.data ? computeSmartPlay(entry.data).suggestion : null]),
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
