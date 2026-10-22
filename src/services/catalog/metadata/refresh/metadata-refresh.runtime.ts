import { providerService } from "@/plugins/capabilities/provider.service";
import { metadataRepository } from "@/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/repositories/metadata-persistence.repository";
import { mapProviderLinks, seasonEpisodesFetcher } from "@/services/catalog/catalog.utils";
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
	transformMetadata: async (candidate) => await pluginHookBus.run("beforeMetadataSave", candidate),
	updateMetadata: async (metadataId, values) => await metadataRepository.update({ primaryId: metadataId, values }),
	syncCredits: (metadataId, providerName, metadata, lockedFields) => {
		return metadataPersistenceRepository.syncCredits(metadataId, providerName, metadata, lockedFields);
	},
	syncMetadataRelations: async (metadataId, providerName, metadata, lockedFields) => {
		await metadataPersistenceRepository.syncMetadataRelations(metadataId, providerName, metadata, lockedFields);
	},
	// Seasons and episodes in the same library language as the series details above.
	syncSeasonsAndEpisodes: async (metadataId, _providerName, metadata, providers) =>
		await syncSeasonsAndEpisodes(
			metadataId,
			metadata.seasons,
			seasonEpisodesFetcher(mapProviderLinks(providers), await resolveMetadataLanguage(metadataId)),
		),
	publishRefreshed: (metadataId, correlationId) => pluginEventBus.publish("metadata.refreshed", { metadataId, correlationId }),
	enqueueImages: async (data, scheduling) => {
		await enqueueImageProcessing(data, scheduling);
	},
});
