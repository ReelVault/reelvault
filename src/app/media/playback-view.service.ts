import type { PlaybackViewResponse } from "@reelvault/sdk/common";
import { playbackProgressService } from "@/app/playback/playback-progress.service";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { serverConfig } from "@/config/server/server.config";
import { toPublicSubtitle } from "@/modules/subtitles/subtitle.mapper";
import { assertFound, assertProfileId } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { mediaService } from "./media-files/media-files.service";
import { resolveEffectivePlaybackPreferences } from "./playback-view.utils";

export const playbackViewService = {
	serviceName: "PlaybackViewService",
	logger: createLogger("PlaybackViewService"),

	async getPlaybackView(mediaFileId: string, profileId?: string): Promise<PlaybackViewResponse> {
		return await runSafely(playbackViewService, "getPlaybackView", async () => {
			assertProfileId(profileId);
			// One statement carries the file, its relation graph, its markers, the
			// root metadata row and (for episode files) the episode with its media
			// files — the detail-page relation load (10 queries) would be pure waste.
			const { mediaFile, metadata, episode, markers } = await mediaService.getPlaybackContext(mediaFileId);
			assertFound(metadata, "Metadata", mediaFile.metadataId);

			const subtitles = mediaFile.subtitles.map(toPublicSubtitle);

			const [overview, preferences] = await Promise.all([
				playbackProgressService
					.getPlaybackOverview(mediaFile.metadataId, profileId, episode ? { id: episode.id, seasonId: episode.seasonId } : undefined)
					.catch(() => null),
				profilePreferencesRepository.getEffective({ profileId }),
			]);

			// The contract field means "the episode after playbackViewService one"; the overview
			// derives it from the show data it already loaded. The show-level
			// smart-play suggestion (type "continue") points back at the current
			// file, so it must not leak in as a next-episode target.
			const nextEpisodeFileId = overview?.nextEpisodeFileId ?? null;

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
	},
};
