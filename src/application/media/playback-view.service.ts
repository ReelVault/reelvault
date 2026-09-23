import type { PlaybackViewResponse } from "@sdk/common";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { toPublicSubtitle } from "@/modules/subtitles/subtitle.mapper";
import { BaseService } from "@/utils/base-service";
import { episodesService } from "../catalog/episodes.service";
import { metadataService } from "../catalog/metadata/metadata.service";
import { mediaService } from "./media-files/media-files.service";

class PlaybackViewService extends BaseService {
	constructor() {
		super("PlaybackViewService");
	}

	async getPlaybackView(mediaFileId: string, profileId?: string): Promise<PlaybackViewResponse> {
		return await this.safeExecute("getPlaybackView", async () => {
			this.assertExists(profileId, "Profile", "auth");
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

			return {
				mediaFile,
				metadata,
				episode: episode ?? null,
				markers,
				subtitles,
				progress: overview?.progress.progress ?? null,
				nextEpisode: overview?.smartPlay.suggestion ?? null,
			};
		});
	}
}

export const playbackViewService = new PlaybackViewService();
