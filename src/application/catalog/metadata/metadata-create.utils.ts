import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import type { AggregatedProviderLink } from "@/plugins/capabilities/metadata-aggregator";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { serverConfig } from "@/server.config";
import { PromiseUtils } from "@/utils/promise.utils";
import { applyMetadataCandidate, toMetadataCandidate } from "./metadata-normalization";

export interface CreatedProviderMetadata {
	metadataId: string;
	metadata: ProviderMetadataResult;
	metadataStableKey: string | null;
	created: boolean;
	personImages: Array<{ personId: string; url: string }>;
}

/**
 * Shared provider→metadata creation path: runs the beforeMetadataSave hook,
 * applies the plugin candidate and persists the row. Callers own artwork
 * scheduling and the metadata.saved publish.
 */
export async function createFromProvider({
	type,
	providerName,
	providerMetadata,
	matchScore,
	providers,
}: {
	type: "movie" | "tv_show";
	providerName: string;
	providerMetadata: ProviderMetadataResult;
	matchScore?: number | undefined;
	providers?: readonly AggregatedProviderLink[] | undefined;
}): Promise<CreatedProviderMetadata> {
	const candidate = await pluginHookBus.runBeforeMetadataSave(toMetadataCandidate(type, providerName, providerMetadata));
	const metadata = applyMetadataCandidate(type, providerName, providerMetadata, candidate);
	const result = await metadataPersistenceRepository.createProviderMetadata({ type, providerName, providers, metadata, matchScore });

	return {
		metadataId: result.metadata.id,
		metadata,
		metadataStableKey: result.metadata.stableKey,
		created: result.created,
		personImages: result.personImages,
	};
}

/** Fans person portraits out through the caller's processor, bounded by the configured limit and enqueue concurrency. */
export async function processPersonImages(
	personImages: ReadonlyArray<{ personId: string; url: string }>,
	process: (image: { personId: string; url: string }) => Promise<unknown>,
): Promise<void> {
	const limited = personImages.slice(0, serverConfig.application.metadataPersonImageLimit);
	await PromiseUtils.mapConcurrent(limited, serverConfig.application.metadataImageEnqueueConcurrency, process);
}
