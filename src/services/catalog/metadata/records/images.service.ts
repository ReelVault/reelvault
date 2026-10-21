import type { MetadataImageOption, SelectMetadataImage } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { imageUploadService } from "@/modules/images/image-upload.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { metadataRepository } from "@/repositories/metadata.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { fetchSeason, mapProviderLinks, runBulkItems } from "@/services/catalog/catalog.utils";
import { resolveMetadataLanguage } from "@/services/catalog/metadata/providers/library-metadata-language.resolver";
import { syncSeasonsAndEpisodes } from "@/services/catalog/metadata/refresh/season-sync.utils";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { toMap } from "@/utils/array.utils";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { rankImageOptions } from "@/utils/image-storage.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { invalidateReadCaches, type MetadataServiceState, type WithoutState } from "./shared.utils";

type RefreshImagesOne = (...args: WithoutState<typeof refreshImages>) => ReturnType<typeof refreshImages>;

/**
 * Retrieve poster and backdrop image options available from linked providers.
 * Options are ranked by the provider's own score (best first); unscored
 * candidates keep their provider order after the scored ones.
 */
export async function getImageOptions(state: MetadataServiceState, metadataId: string): Promise<MetadataImageOption[]> {
	return await runSafely(state, "getImageOptions", async () => {
		const metadata = await metadataRepository.findProviderDetails(metadataId);
		assertFound(metadata, "Metadata", metadataId);
		const providers = metadata.providers.filter((provider) => provider.entityType === metadata.type);
		const options = await mapConcurrent(providers, serverConfig.application.metadataImageProviderConcurrency, async (provider) =>
			(await providerService.fetchImagesByProvider(provider.name, metadata.type, provider.externalId)).map((image) => ({
				providerId: provider.name,
				providerName: provider.name,
				externalId: provider.externalId,
				...image,
			})),
		);

		return rankImageOptions(options.flat());
	});
}

/**
 * Select and download a specific candidate image from a provider.
 */
export async function selectImage(
	state: MetadataServiceState,
	metadataId: string,
	selection: SelectMetadataImage,
	context?: AdminAuditContext,
): Promise<{ success: true }> {
	return await runSafely(state, "selectImage", async () => {
		const metadata = await metadataRepository.findProviderDetails(metadataId);
		assertFound(metadata, "Metadata", metadataId);
		const providerMap = toMap(metadata.providers, (p) => `${p.name}:${p.entityType}`);
		const provider = providerMap.get(`${selection.providerId}:${metadata.type}`);
		if (!provider)
			throw new DomainError("validation", "Selected provider is not linked to this metadata", { code: "metadata.provider_not_linked" });

		// The request body URL is never trusted: only artwork the provider
		// actually offers (re-resolved now) may be downloaded.
		const offered = await providerService.fetchImagesByProvider(provider.name, metadata.type, provider.externalId);
		const isOffered = offered.some((image) => image.type === selection.type && image.url === selection.url);
		if (!isOffered)
			throw new DomainError("validation", "Selected image is not offered by this provider", { code: "metadata.image_not_offered" });

		await imageProcessingService.replaceMetadataImage(metadataId, selection.type, selection.url);
		invalidateReadCaches();

		recordAuditSafe(
			{
				action: "update",
				resourceType: "metadata_image",
				resourceId: metadataId,
				after: selection,
				context,
			},
			state.logger,
		);

		return { success: true as const };
	});
}

/**
 * Upload a custom poster or backdrop image for a metadata item.
 */
export async function uploadImage(
	state: MetadataServiceState,
	metadataId: string,
	type: "poster" | "backdrop",
	file: File,
	context?: AdminAuditContext,
): Promise<{ success: true }> {
	return await runSafely(state, "uploadImage", async () => {
		const uploaded = await imageUploadService.upload(file, { ownerType: "metadata", ownerId: metadataId, variant: type });
		await imageProcessingService.replaceMetadataImageWithUpload(metadataId, type, uploaded);
		invalidateReadCaches();

		recordAuditSafe(
			{
				action: "update",
				resourceType: "metadata_image_upload",
				resourceId: metadataId,
				after: { type, fileName: file.name, fileSize: file.size },
				context,
			},
			state.logger,
		);

		return { success: true as const };
	});
}

/** Force-refreshes the artwork of the listed titles one after another; each id reports its own outcome. */
export async function refreshImagesMany(state: MetadataServiceState, metadataIds: string[], refreshOne: RefreshImagesOne) {
	return await runSafely(
		state,
		"refreshImagesMany",
		async () => await runBulkItems(metadataIds, (metadataId) => refreshOne(metadataId, { force: true }), "metadata.refresh_images_failed"),
	);
}

export async function refreshImages(
	state: MetadataServiceState,
	metadataId: string,
	options: { force?: boolean } = {},
): Promise<{ success: boolean }> {
	return await runSafely(state, "refreshImages", async () => {
		const metadata = await metadataRepository.findProviderDetails(metadataId);
		assertFound(metadata, "Metadata", metadataId);

		const providersByName = toMap(metadata.providers, (p) => p.name);
		const primaryProvider =
			(metadata.primaryProviderId ? providersByName.get(metadata.primaryProviderId) : undefined) ?? metadata.providers[0];
		if (!primaryProvider) {
			throw new DomainError("not_found", "Metadata provider not found for title", {
				code: "metadata.provider_not_found",
				params: { metadataId },
			});
		}

		const providerMetadata = await providerService.fetchDetailsByProvider(primaryProvider.name, metadata.type, primaryProvider.externalId, {
			language: await resolveMetadataLanguage(metadataId),
		});
		if (!providerMetadata) {
			throw new DomainError("not_found", "Could not fetch details from provider", {
				code: "metadata.provider_details_not_found",
				params: { providerId: primaryProvider.name, externalId: primaryProvider.externalId },
			});
		}

		const isForce = options.force ?? true;

		const imagesToProcess: Array<{ type: "poster" | "backdrop"; url?: string }> = [];
		if (providerMetadata.posterPath) imagesToProcess.push({ type: "poster", url: providerMetadata.posterPath });

		if (providerMetadata.backdropPath) imagesToProcess.push({ type: "backdrop", url: providerMetadata.backdropPath });

		if (imagesToProcess.length > 0) {
			await imageProcessingService.processMetadata(metadataId, imagesToProcess, isForce);
		}

		if (metadata.type === "tv_show") {
			await syncSeasonEpisodeImages(metadataId, metadata, providerMetadata, isForce);
		}

		invalidateReadCaches();
		pluginEventBus.publish("metadata.saved", { metadataId });

		return { success: true };
	});
}

async function syncSeasonEpisodeImages(
	metadataId: string,
	metadata: { providers?: Array<{ name: string; externalId: string }> | undefined; type: string },
	providerMetadata: ProviderMetadataResult,
	isForce: boolean,
): Promise<void> {
	const providerLinks = mapProviderLinks(metadata.providers ?? []);
	const seasonImages = await syncSeasonsAndEpisodes(metadataId, providerMetadata.seasons, async (seasonNumber) => {
		const season = await fetchSeason(providerLinks, seasonNumber);

		return season?.episodes;
	});

	// Thunks: image tasks must not start until mapConcurrent schedules them,
	// otherwise the concurrency limit of 5 would have no effect.
	const imageTasks: Array<() => Promise<void>> = [];
	for (const img of seasonImages) {
		if (img.kind === "season" && img.urls) {
			imageTasks.push(() =>
				imageProcessingService.processSeason({
					metadataId: img.metadataId,
					seasonId: img.seasonId,
					imagesUrl: img.urls,
					force: isForce,
				}),
			);
		} else if (img.kind === "episode" && img.urls) {
			imageTasks.push(() =>
				imageProcessingService.processEpisode({
					metadataId: img.metadataId,
					episodeId: img.episodeId,
					imagesUrl: img.urls,
					force: isForce,
				}),
			);
		}
	}

	await mapConcurrent(imageTasks, systemResourcesService.getSharpConcurrency(), (task) => task());
}
