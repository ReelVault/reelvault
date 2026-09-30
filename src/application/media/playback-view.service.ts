import type { PlaybackViewResponse } from "@reelvault/sdk/common";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { nextEpisodeAfter, selectPreferredMediaFile } from "@/modules/streaming/progress/smart-play";
import { toPublicSubtitle } from "@/modules/subtitles/subtitle.mapper";
import { BaseService } from "@/utils/base-service";
import { episodesService } from "../catalog/episodes.service";
import { metadataService } from "../catalog/metadata/metadata.service";
import { seasonsService } from "../catalog/seasons.service";
import { mediaService } from "./media-files/media-files.service";

const EPISODE_FILES_FIELDS = "id,episodeNumber,mediaFiles.id,mediaFiles.isDefault,mediaFiles.updatedAt";

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
			const seasonEpisodes = await episodesService.getAll({
				seasonId: episode.seasonId,
				sortBy: "episodeNumber",
				sortOrder: "asc",
				fields: EPISODE_FILES_FIELDS,
				limit: 100,
			});
			const sorted = seasonEpisodes.data.toSorted((left, right) => left.episodeNumber - right.episodeNumber);
			const next = nextEpisodeAfter(sorted, episode.id);
			const nextFile = next ? selectPreferredMediaFile(next.mediaFiles) : undefined;
			if (nextFile) return nextFile.id;

			const seasons = await seasonsService.getAll({
				metadataId,
				fields: "id,seasonNumber",
				sortBy: "seasonNumber",
				sortOrder: "asc",
				limit: 100,
			});
			const orderedSeasons = seasons.data.toSorted((left, right) => left.seasonNumber - right.seasonNumber);
			const currentSeasonIndex = orderedSeasons.findIndex((season) => season.id === episode.seasonId);
			for (const season of orderedSeasons.slice(currentSeasonIndex + 1)) {
				const firstEpisodes = await episodesService.getAll({
					seasonId: season.id,
					sortBy: "episodeNumber",
					sortOrder: "asc",
					fields: EPISODE_FILES_FIELDS,
					limit: 1,
				});
				const firstFile = selectPreferredMediaFile(firstEpisodes.data[0]?.mediaFiles ?? []);
				if (firstFile) return firstFile.id;
			}

			return null;
		} catch (error) {
			this.logger.warn("Failed to resolve next episode for playback view", { mediaFileId: episode.id, error });
			return null;
		}
	}
}

export const playbackViewService = new PlaybackViewService();
