import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { enqueueImageProcessing } from "@/workers/definitions/images/image-processing.worker";
import { fetchSeason, mapProviderLinks } from "../catalog.utils";
import { MetadataRefreshService } from "./metadata-refresh.service";
import { syncSeasonsAndEpisodes } from "./season-sync.utils";

export const metadataRefreshService = new MetadataRefreshService({
	findMetadata: async (metadataId) => await metadataRepository.findProviderDetails(metadataId),
	getLockedFields: async (metadataId) => await metadataRepository.getLockedFields(metadataId),
	fetchProviderDetails: async (providerId, type, externalId) => await providerService.fetchDetailsByProvider(providerId, type, externalId),
	transformMetadata: async (candidate) => await pluginHookBus.runBeforeMetadataSave(candidate),
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
			const season = await fetchSeason(links, seasonNumber);

			return season?.episodes;
		});
	},
	publishRefreshed: (metadataId, correlationId) => pluginEventBus.publish("metadata.refreshed", { metadataId, correlationId }),
	enqueueImages: async (data, scheduling) => {
		await enqueueImageProcessing(data, scheduling);
	},
});
