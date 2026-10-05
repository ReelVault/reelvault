import type {
	BatchSmartPlayResponse,
	ContinueWatchingItem,
	MetadataPlaybackProgress,
	MetadataType,
	StreamPrefs,
	UpdatePlaybackProgress,
} from "@reelvault/sdk/common";
import { playbackRepository as defaultPlaybackRepository } from "@/database/repositories/playback.repository";
import { profilePreferencesRepository as defaultProfilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository as defaultProfileStreamPrefsRepository } from "@/database/repositories/profile-stream-prefs.repository";
import { watchedHistoryRepository as defaultWatchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { watchlistRepository as defaultWatchlistRepository } from "@/database/repositories/watchlist.repository";
import { isNotNullish, trimAndFilter, unique } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { invalidateProfileResponseBodies } from "@/utils/response-body-cache";
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
	| "deleteProgress"
	| "deleteMetadataProgress"
>;

export type WatchedHistoryRepo = Pick<typeof defaultWatchedHistoryRepository, "sync">;
export type WatchlistRepo = Pick<typeof defaultWatchlistRepository, "findWatchlistedIds">;

/** Hard cap for the batch smart-play endpoint (guards giant query strings). */
const MAX_BATCH_IDS = 50;

export type ProfileStreamPrefsRepo = Pick<typeof defaultProfileStreamPrefsRepository, "upsert" | "find" | "findByMediaFile">;

export interface ProfilePreferencesRepo {
	getEffective(input: { profileId: string }): Promise<{ continueWatchingMinutes: number }>;
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

class PlaybackProgressService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("PlaybackProgressService");
		this.dependencies = dependencies;
	}

	async updatePlaybackProgress(fileId: string, body: UpdatePlaybackProgress, profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("updatePlaybackProgress", async () => {
			const { playbackRepository, watchedHistoryRepository, publisher } = this.dependencies;
			this.assertProfileId(profileId);
			const { mediaFile, existingProgress } = await playbackRepository.findProgressUpdateData(fileId, profileId);
			this.assertExists(mediaFile, "MediaFile", fileId);

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
		return await this.safeExecute("getStreamPrefs", async () => {
			this.assertProfileId(profileId);
			// One LEFT JOIN resolves file→metadata→prefs (was two chained selects).
			const resolved = await this.dependencies.profileStreamPrefsRepository.findByMediaFile(fileId, profileId);
			this.assertExists(resolved, "MediaFile", fileId);

			return resolved.prefs;
		});
	}

	async resetPlaybackProgress(fileId: string, profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("resetPlaybackProgress", async () => {
			const { playbackRepository } = this.dependencies;
			this.assertProfileId(profileId);
			const mediaFile = await playbackRepository.findMediaFileWithMetadata(fileId);
			if (mediaFile?.metadataId) {
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
		return await this.safeExecute("getPlaybackOverview", async () => {
			const { playbackRepository } = this.dependencies;
			this.assertProfileId(profileId);
			const data = await playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, profileId, metadataType);
			this.assertExists(data, "Metadata", metadataId);

			return {
				progress: computePlaybackProgress(data),
				smartPlay: computeSmartPlay(data),
			};
		});
	}

	async getPlaybackProgress(metadataId: string, profileId?: string, metadataType?: MetadataType): Promise<MetadataPlaybackProgress> {
		return await this.safeExecute("getPlaybackProgress", async () => {
			const { playbackRepository } = this.dependencies;
			this.assertProfileId(profileId);
			const data = await playbackRepository.findPlaybackProgressAndSmartPlayData(metadataId, profileId, metadataType);
			this.assertExists(data, "Metadata", metadataId);

			return computePlaybackProgress(data);
		});
	}

	async getContinueWatching(profileId?: string, limit = 12): Promise<{ items: ContinueWatchingItem[] }> {
		return await this.safeExecute("getContinueWatching", async () => {
			const { playbackRepository } = this.dependencies;
			this.assertProfileId(profileId);
			const data = await playbackRepository.findContinueWatchingData(profileId, limit);
			const preferences = await this.dependencies.profilePreferencesRepository.getEffective({ profileId });

			return { items: buildContinueWatching(data, limit, preferences.continueWatchingMinutes * 60) };
		});
	}

	async getSmartPlay(metadataId: string, profileId?: string): Promise<SmartPlay> {
		return await this.safeExecute("getSmartPlay", async () => {
			const { playbackRepository } = this.dependencies;
			this.assertProfileId(profileId);
			const data = await playbackRepository.findSmartPlayData(metadataId, profileId);
			this.assertExists(data, "Metadata", metadataId);

			return computeSmartPlay({
				metadata: data.metadata,
				mediaFiles: data.mediaFiles,
				progressRows: data.progress,
				seasons: data.seasons,
				episodes: data.episodes,
			});
		});
	}

	/** Batch smart play + watchlist flags — one request for a whole grid of cards. */
	async getSmartPlayBatch(metadataIds: string[], profileId?: string): Promise<BatchSmartPlayResponse> {
		return await this.safeExecute("getSmartPlayBatch", async () => {
			this.assertProfileId(profileId);
			const ids = unique(trimAndFilter(metadataIds)).slice(0, MAX_BATCH_IDS);
			if (ids.length === 0) return { suggestions: [] };

			const [resolved, watchlisted] = await Promise.all([
				Promise.all(
					ids.map((metadataId) =>
						this.getSmartPlay(metadataId, profileId)
							.then((smartPlay) => ({ metadataId, suggestion: smartPlay.suggestion }))
							.catch(() => ({ metadataId, suggestion: null })),
					),
				),
				this.dependencies.watchlistRepository.findWatchlistedIds(profileId, ids).catch(() => new Set<string>()),
			]);

			return {
				suggestions: resolved
					.filter((item) => isNotNullish(item.metadataId))
					.map((item) => ({
						metadataId: item.metadataId,
						suggestion: item.suggestion,
						inWatchlist: watchlisted.has(item.metadataId),
					})),
			};
		});
	}
}

export const playbackProgressService = new PlaybackProgressService();

export { PlaybackProgressService };
