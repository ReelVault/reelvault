import { pluginsService } from "@/application/plugins.service";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { enqueueImageProcessing } from "@/workers/definitions/images/image-processing.worker";
import { findFirstProviderResult, mapProviderLinks } from "../catalog.utils";
import { MetadataRefreshService } from "./metadata-refresh.service";
import { syncSeasonsAndEpisodes } from "./season-sync.utils";

export const metadataRefreshService = new MetadataRefreshService({
	findMetadata: async (metadataId) => await metadataRepository.findProviderDetails(metadataId),
	getLockedFields: async (metadataId) => await metadataRepository.getLockedFields(metadataId),
	fetchProviderDetails: async (providerId, type, externalId) =>
		await pluginsService.fetchProviderDetailsByProvider(providerId, type, externalId),
	transformMetadata: async (candidate) => await pluginsService.transformMetadataCandidate(candidate),
	updateMetadata: async (metadataId, values) => await metadataRepository.update({ primaryId: metadataId, values }),
	syncCredits: (metadataId, providerName, metadata, lockedFields) => {
		return metadataPersistenceRepository.syncCredits(metadataId, providerName, metadata, lockedFields);
	},
	syncMetadataRelations: async (metadataId, providerName, metadata, lockedFields) => {
		await metadataPersistenceRepository.syncMetadataRelations(metadataId, providerName, metadata, lockedFields);
	},
	syncSeasonsAndEpisodes: (metadataId, _providerName, metadata, providers) => {
		const links = mapProviderLinks(providers);

		return syncSeasonsAndEpisodes(metadataId, metadata.seasons, async (seasonNumber) => {
			const providerSeasons = await pluginsService.fetchProviderSeasonFromLinks(links, seasonNumber);

			return findFirstProviderResult(providerSeasons)?.episodes;
		});
	},
	publishRefreshed: (metadataId, correlationId) => pluginsService.publish("metadata.refreshed", { metadataId, correlationId }),
	enqueueImages: async (data, scheduling) => {
		await enqueueImageProcessing(data, scheduling);
	},
});
