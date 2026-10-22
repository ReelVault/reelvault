import type { EpisodeFilters, EpisodeSorting, EpisodeWithRelations } from "@reelvault/sdk/common";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { episodesRepository } from "@/repositories/episodes.repository";
import { metadataRepository } from "@/repositories/metadata.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { resolveMetadataLanguage } from "@/services/catalog/metadata/providers/library-metadata-language.resolver";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { findFirstProviderResult, invalidateCatalogLists, mapProviderLinks, runBulkItems } from "./catalog.utils";
import { DictionaryReadService } from "./dictionary-crud.service";

class EpisodesService extends DictionaryReadService<EpisodeWithRelations, EpisodeFilters, EpisodeSorting, typeof episodesRepository> {
	constructor() {
		super("EpisodesService", "Episode", episodesRepository);
	}

	async refresh(episodeId: string, options: { forceImage?: boolean } = {}) {
		return await runSafely(this, "refresh", async () => {
			const episode = await episodesRepository.findByPrimaryId({
				primaryId: episodeId,
				fields: parseFields({ fields: "id,seasonId,episodeNumber,title,overview,airDate,imageId" }),
			});
			assertFound(episode, "Episode", episodeId);

			const season = await seasonsRepository.findByPrimaryId({
				primaryId: episode.seasonId,
				fields: parseFields({ fields: "id,seasonNumber,metadataId" }),
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

			// The library language, as the import and the title refresh use: a refresh must not swap the episode's language.
			const language = await resolveMetadataLanguage(season.metadataId);
			const providerEpisodes = await providerService.fetchEpisodeFromLinks(providerLinks, seasonNum, episodeNum, language);
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

				if (match.thumbnailPath && (options.forceImage || !episode.imageId)) {
					await imageProcessingService.processEpisode({
						metadataId: season.metadataId,
						episodeId: episode.id,
						imagesUrl: match.thumbnailPath,
						force: options.forceImage,
					});
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
		return await runSafely(
			this,
			"refreshMany",
			async () => await runBulkItems(episodeIds, (episodeId) => this.refresh(episodeId), "episode.refresh_failed"),
		);
	}
}

export const episodesService = new EpisodesService();
