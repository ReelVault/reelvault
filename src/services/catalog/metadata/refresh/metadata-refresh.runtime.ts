import { providerService } from "@/plugins/capabilities/provider.service";
import { metadataRepository } from "@/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/repositories/metadata-persistence.repository";
import { fetchSeason, mapProviderLinks } from "@/services/catalog/catalog.utils";
import { resolveMetadataLanguage } from "@/services/catalog/metadata/providers/library-metadata-language.resolver";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { pluginHookBus } from "@/system/extensions/plugin.hooks";
import { enqueueImageProcessing } from "@/workers/definitions/images/image-processing.worker";
import { MetadataRefreshService } from "./metadata-refresh.service";
import { syncSeasonsAndEpisodes } from "./season-sync.utils";

export const metadataRefreshService = new MetadataRefreshService({
	findMetadata: async (metadataId) => await metadataRepository.findProviderDetails(metadataId),
	getLockedFields: async (metadataId) => await metadataRepository.getLockedFields(metadataId),
	fetchProviderDetails: async (providerId, type, externalId, metadataId) =>
		await providerService.fetchDetailsByProvider(providerId, type, externalId, { language: await resolveMetadataLanguage(metadataId) }),
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
