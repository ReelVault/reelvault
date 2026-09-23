import type { EpisodeFilters, EpisodeSorting, EpisodeWithRelations } from "@sdk/common/episode.types";
import type { FieldsQuery, SelectFields } from "@sdk/common/fields";
import type { PaginatedResponse, PaginationQuery } from "@sdk/common/pagination";
import { pluginsService } from "@/application/plugins.service";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
import { findFirstProviderResult, mapProviderLinks } from "./catalog.utils";

class EpisodesService extends BaseService {
	constructor() {
		super("EpisodesService");
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & EpisodeFilters & EpisodeSorting,
	): Promise<PaginatedResponse<SelectFields<EpisodeWithRelations, F>>> {
		return await this.safeExecute("getAll", () => episodesRepository.findPage(query));
	}

	async getById<F extends string>(episodeId: string, query?: FieldsQuery<F>): Promise<SelectFields<EpisodeWithRelations, F>> {
		return await this.safeExecute("getById", async () => {
			const media = await episodesRepository.findByIdForRead(episodeId, query);
			this.assertExists(media, "Episode", episodeId);

			return media;
		});
	}

	async refresh(episodeId: string, options: { forceImage?: boolean } = {}) {
		return await this.safeExecute("refresh", async () => {
			const episode = await episodesRepository.findByPrimaryId({
				primaryId: episodeId,
				fields: QueryFields.parse({ fields: "id,seasonId,episodeNumber,title,overview,airDate,imageId" }),
			});
			this.assertExists(episode, "Episode", episodeId);

			const season = await seasonsRepository.findByPrimaryId({
				primaryId: episode.seasonId,
				fields: QueryFields.parse({ fields: "id,seasonNumber,metadataId" }),
			});
			this.assertExists(season, "Season", episode.seasonId);

			const metadata = await metadataRepository.findProviderDetails(season.metadataId);
			this.assertExists(metadata, "Metadata", season.metadataId);

			const providerLinks = mapProviderLinks(metadata.providers);
			if (providerLinks.length === 0) {
				throw new NotFoundError("Metadata provider not found for series");
			}

			const seasonNum = season.seasonNumber;
			const episodeNum = episode.episodeNumber;

			const providerEpisodes = await pluginsService.fetchProviderEpisodeFromLinks(providerLinks, seasonNum, episodeNum);
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

			// Episode fields changed — rewrite the series/episode sidecar documents.
			sidecarSyncService.scheduleSync(season.metadataId);

			return await this.getById(episodeId);
		});
	}

	async refreshImage(episodeId: string) {
		return await this.refresh(episodeId, { forceImage: true });
	}
}

export const episodesService = new EpisodesService();
