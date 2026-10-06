import type { PlaybackViewResponse } from "@reelvault/sdk/common";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { toPublicSubtitle } from "@/modules/subtitles/subtitle.mapper";
import { BaseService } from "@/utils/base-service";
import { episodesService } from "../catalog/episodes.service";
import { metadataService } from "../catalog/metadata/metadata.service";
import { mediaService } from "./media-files/media-files.service";
import { resolveNextEpisodeFileId } from "./playback-view.utils";

class PlaybackViewService extends BaseService {
	constructor() {
		super("PlaybackViewService");
	}

	async getPlaybackView(mediaFileId: string, profileId?: string): Promise<PlaybackViewResponse> {
		return await this.safeExecute("getPlaybackView", async () => {
			this.assertProfileId(profileId);
			const mediaFile = await mediaService.getById(mediaFileId);
			this.assertExists(mediaFile, "MediaFile", mediaFileId);

			// Flat row only: the contract ships the root metadata object, so the
			// detail-page relation load (10 queries) would be pure waste. The row
			// must exist before the overview runs — its type skips the findTypeById
			// re-read inside the repository.
			const metadata = await metadataService.getRootsById(mediaFile.metadataId);
			this.assertExists(metadata, "Metadata", mediaFile.metadataId);

			const subtitles = mediaFile.subtitles.map(toPublicSubtitle);

			const [episode, markers, overview] = await Promise.all([
				mediaFile.episodeId ? episodesService.getById(mediaFile.episodeId).catch(() => null) : Promise.resolve(null),
				mediaService.listMarkers(mediaFileId, { skipExistsCheck: true }),
				playbackProgressService.getPlaybackOverview(mediaFile.metadataId, profileId, metadata.type).catch(() => null),
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
