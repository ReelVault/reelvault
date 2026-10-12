import type { BulkRefreshItem, EpisodeFilters, EpisodeSorting, EpisodeWithRelations } from "@reelvault/sdk/common";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { assertFound, DomainError } from "@/utils/errors";
import { runSafely } from "@/utils/safe-execute";
import { findFirstProviderResult, invalidateCatalogLists, mapProviderLinks, runBulkItem } from "./catalog.utils";
import { DictionaryReadService } from "./dictionary-crud.service";

class EpisodesService extends DictionaryReadService<EpisodeWithRelations, EpisodeFilters, EpisodeSorting, typeof episodesRepository> {
	constructor() {
		super("EpisodesService", "Episode", episodesRepository);
	}

	async refresh(episodeId: string, options: { forceImage?: boolean } = {}) {
		return await runSafely(this, "refresh", async () => {
			const episode = await episodesRepository.findByPrimaryId({
				primaryId: episodeId,
				fields: QueryFields.parse({ fields: "id,seasonId,episodeNumber,title,overview,airDate,imageId" }),
			});
			assertFound(episode, "Episode", episodeId);

			const season = await seasonsRepository.findByPrimaryId({
				primaryId: episode.seasonId,
				fields: QueryFields.parse({ fields: "id,seasonNumber,metadataId" }),
			});
			assertFound(season, "Season", episode.seasonId);

			const metadata = await metadataRepository.findProviderDetails(season.metadataId);
			assertFound(metadata, "Metadata", season.metadataId);

			const providerLinks = mapProviderLinks(metadata.providers);
			if (providerLinks.length === 0) {
				throw new DomainError("not_found", "Metadata provider not found for series", { code: "metadata.provider_not_found" });
			}

			const seasonNum = season.seasonNumber;
			const episodeNum = episode.episodeNumber;

			const providerEpisodes = await providerService.fetchEpisodeFromLinks(providerLinks, seasonNum, episodeNum);
			const match = findFirstProviderResult(providerEpisodes);

			if (match) {
				await episodesRepository.update({
					primaryId: episode.id,
					values: {
						title: match.name ?? episode.title,
						overview: match.overview ?? episode.overview,
						airDate: match.airDate ?? episode.airDate,
					},
				});

				if (match.thumbnailPath) {
					if (options.forceImage || !episode.imageId) {
						await imageProcessingService.processEpisode({
							metadataId: season.metadataId,
							episodeId: episode.id,
							imagesUrl: match.thumbnailPath,
							force: options.forceImage,
						});
					}
				}
			}

			invalidateCatalogLists();

			// Episode fields changed — rewrite the series/episode sidecar documents.
			sidecarSyncService.scheduleSync(season.metadataId);

			return await this.getById(episodeId);
		});
	}

	async refreshImage(episodeId: string) {
		return await this.refresh(episodeId, { forceImage: true });
	}

	/** Refreshes the listed episodes one after another, so provider calls stay sequential; each id reports its own outcome. */
	async refreshMany(episodeIds: string[]) {
		return await runSafely(this, "refreshMany", async () => {
			const results: BulkRefreshItem[] = [];
			for (const episodeId of new Set(episodeIds)) {
				results.push(await runBulkItem(episodeId, () => this.refresh(episodeId), "episode.refresh_failed"));
			}

			return { results };
		});
	}
}

export const episodesService = new EpisodesService();
