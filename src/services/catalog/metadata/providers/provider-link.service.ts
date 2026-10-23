import type { FieldsQuery, MetadataWithRelation, SelectFields } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { metadataRepository } from "@/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/repositories/metadata-persistence.repository";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { metadataLog } from "@/services/catalog/metadata/metadata.logger";
import { resolveMetadataLanguage } from "@/services/catalog/metadata/providers/library-metadata-language.resolver";
import { invalidateReadCaches } from "@/services/catalog/metadata/records/read-caches.utils";
import { metadataRefreshService } from "@/services/catalog/metadata/refresh/metadata-refresh.runtime";
import { syncSeasonsAndEpisodes } from "@/services/catalog/metadata/refresh/season-sync.utils";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";

interface LinkedProviderTarget {
	metadataId: string;
	existing: { type: "movie" | "tv_show" };
	link: { providerId: string; externalId: string };
}

/** Artwork a lock protects is left out of the replacement, so the stored image stays. */
function unlockedArtwork(artwork: { posterPath?: string | undefined; backdropPath?: string | undefined }, lockedFields: readonly string[]) {
	return {
		posterPath: lockedFields.includes("posters") ? undefined : artwork.posterPath,
		backdropPath: lockedFields.includes("backdrops") ? undefined : artwork.backdropPath,
	};
}

export async function rematch<F extends string>(
	metadataId: string,
	body: { providerId: string; externalId: string; overwriteLocked?: boolean | undefined },
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MetadataWithRelation, F>> {
	return await runSafely(metadataLog, "rematch", async () => {
		const existing = await metadataRepository.findByIdForRead(metadataId, { fields: "id,type" });
		assertFound(existing, "Metadata", metadataId);

		// Locked fields keep their stored values unless the administrator asks to overwrite them too.
		let lockedFields: string[];
		if (body.overwriteLocked === true) {
			lockedFields = [];
		} else {
			lockedFields = await metadataRepository.getLockedFields(metadataId);
		}

		return await updateLinkedProvider(
			{ metadataId, existing, link: { providerId: body.providerId, externalId: body.externalId } },
			query,
			context,
			{
				resourceType: "metadata_rematch",
				persist: async (providerMetadata) => {
					// awaits: sequential — the provider match is stored before the artwork is replaced from it
					await metadataPersistenceRepository.rematchProviderMetadata({
						metadataId,
						type: existing.type,
						providerName: body.providerId,
						metadata: providerMetadata,
						matchScore: 1.0,
						lockedFields,
					});

					await imageProcessingService.replaceProviderArtwork(metadataId, unlockedArtwork(providerMetadata, lockedFields));

					if (existing.type === "tv_show" && providerMetadata.seasons) {
						await syncSeasonsAndEpisodes(metadataId, providerMetadata.seasons);
					}
				},
				afterInvalidate: () => {
					pluginEventBus.publish("metadata.saved", { metadataId });
					sidecarSyncService.scheduleSync(metadataId);
				},
			},
		);
	});
}

/**
 * Links an additional provider to an existing title and re-aggregates every
 * linked provider by priority. Unlike {@link rematch}, the current primary
 * provider is preserved — the new provider only fills gaps (and adds ratings).
 */
export async function linkProvider<F extends string>(
	metadataId: string,
	body: { providerId: string; externalId: string },
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MetadataWithRelation, F>> {
	return await runSafely(metadataLog, "linkProvider", async () => {
		const existing = await metadataRepository.findByIdForRead(metadataId, { fields: "id,type,providers" });
		assertFound(existing, "Metadata", metadataId);

		return await updateLinkedProvider({ metadataId, existing, link: body }, query, context, {
			resourceType: "metadata_link_provider",
			persist: async (providerMetadata) => {
				// awaits: sequential — the provider link is stored before the metadata is refreshed
				await metadataPersistenceRepository.linkProvider(metadataId, existing.type, body.providerId, body.externalId);
				await metadataRefreshService.refresh(metadataId, { prefetchedProviders: { [body.providerId]: providerMetadata } });
			},
		});
	});
}

/**
 * Shared tail of {@link rematch} and {@link linkProvider}: fetch the provider
 * payload, run the caller's persistence step, invalidate read caches, re-read
 * the row and record the audit entry. Everything that differs between the
 * callers (persistence/artwork work and rematch's event/sidecar hooks) stays
 * in `options`.
 */
async function updateLinkedProvider<F extends string>(
	target: LinkedProviderTarget,
	query: FieldsQuery<F> | undefined,
	context: AdminAuditContext | undefined,
	options: {
		resourceType: string;
		persist: (providerMetadata: ProviderMetadataResult) => Promise<void>;
		afterInvalidate?: () => void;
	},
): Promise<SelectFields<MetadataWithRelation, F>> {
	const { metadataId, existing, link } = target;
	const providerMetadata = await providerService.fetchDetailsByProvider(link.providerId, existing.type, link.externalId, {
		language: await resolveMetadataLanguage(metadataId),
	});
	if (!providerMetadata) {
		throw new DomainError("not_found", "Could not fetch metadata details for the specified provider and external ID", {
			code: "metadata.provider_details_not_found",
			params: { providerId: link.providerId, externalId: link.externalId },
		});
	}

	await options.persist(providerMetadata);

	invalidateReadCaches();
	options.afterInvalidate?.();
	const updated = await metadataRepository.findByIdForRead(metadataId, query);
	assertFound(updated, "Metadata", metadataId);

	recordAuditSafe(
		{
			action: "update",
			resourceType: options.resourceType,
			resourceId: metadataId,
			before: existing,
			after: { providerId: link.providerId, externalId: link.externalId, updated },
			context,
		},
		metadataLog.logger,
	);

	return updated;
}
