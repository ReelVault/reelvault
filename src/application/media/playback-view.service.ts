import type { PlaybackViewResponse } from "@reelvault/sdk/common";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { toPublicSubtitle } from "@/modules/subtitles/subtitle.mapper";
import { serverConfig } from "@/server.config";
import { assertFound, assertProfileId } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { runSafely } from "@/utils/safe-execute";
import { episodesService } from "../catalog/episodes.service";
import { metadataService } from "../catalog/metadata/metadata.service";
import { mediaService } from "./media-files/media-files.service";
import { resolveEffectivePlaybackPreferences, resolveNextEpisodeFileId } from "./playback-view.utils";

class PlaybackViewService {
	readonly serviceName = "PlaybackViewService";
	readonly logger = createLogger("PlaybackViewService");

	async getPlaybackView(mediaFileId: string, profileId?: string): Promise<PlaybackViewResponse> {
		return await runSafely(this, "getPlaybackView", async () => {
			assertProfileId(profileId);
			const mediaFile = await mediaService.getById(mediaFileId);
			assertFound(mediaFile, "MediaFile", mediaFileId);

			// Flat row only: the contract ships the root metadata object, so the
			// detail-page relation load (10 queries) would be pure waste. The row
			// must exist before the overview runs — its type skips the findTypeById
			// re-read inside the repository.
			const metadata = await metadataService.getRootsById(mediaFile.metadataId);
			assertFound(metadata, "Metadata", mediaFile.metadataId);

			const subtitles = mediaFile.subtitles.map(toPublicSubtitle);

			const [episode, markers, overview, preferences] = await Promise.all([
				mediaFile.episodeId ? episodesService.getById(mediaFile.episodeId).catch(() => null) : Promise.resolve(null),
				mediaService.listMarkers(mediaFileId, { skipExistsCheck: true }),
				playbackProgressService.getPlaybackOverview(mediaFile.metadataId, profileId, metadata.type).catch(() => null),
				profilePreferencesRepository.getEffective({ profileId }),
			]);

			// The contract field means "the episode after this one". The show-level
			// smart-play suggestion (type "continue") points back at the current
			// file, so it must not leak in as a next-episode target.
			const nextEpisodeFileId = episode ? await this.findNextEpisodeFileId(episode, mediaFile.metadataId) : null;

			return {
				mediaFile,
				metadata,
				episode: episode ?? null,
				markers,
				subtitles,
				progress: overview?.progress.progress ?? null,
				nextEpisode: nextEpisodeFileId ? { type: "next_episode", mediaFileId: nextEpisodeFileId } : null,
				effectivePreferences: resolveEffectivePlaybackPreferences(preferences, serverConfig.stream.maxPerStreamBandwidthKbps),
			};
		});
	}

	private async findNextEpisodeFileId(episode: { id: string; seasonId: string }, metadataId: string): Promise<string | null> {
		try {
			// One ordered query for the whole show replaces the previous scan
			// (current-season page + season list + one paginated episode page per
			// later season). The helper keeps the "next episode, preferred file"
			// contract aligned with smart play; the later-season fallback stays
			// because smart play already lists every season.
			const rows = await episodesRepository.findEpisodesWithFilesByMetadataId(metadataId);

			return resolveNextEpisodeFileId(rows, episode);
		} catch (error) {
			this.logger.warn("Failed to resolve next episode for playback view", { mediaFileId: episode.id, error });
			return null;
		}
	}
}

export const playbackViewService = new PlaybackViewService();
