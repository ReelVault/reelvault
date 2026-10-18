import type { MediaIdentity } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import {
	type CreatedProviderMetadata,
	createFromProvider,
	processPersonImages,
} from "@/app/catalog/metadata/providers/metadata-create.utils";
import type { AggregatedMetadata, AggregatedProviderLink } from "@/plugins/capabilities/metadata-aggregator.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { processMovieMetadata, processTVShowMetadata } from "./entries.service";
import type { MetadataProcessResult, MetadataProcessState, TvProcessOptions } from "./shared.types";

interface BaseMetadataInput {
	type: "movie" | "tv_show";
	providerName: string;
	providerMetadata: ProviderMetadataResult;
	matchScore?: number | undefined;
	providers?: AggregatedProviderLink[] | undefined;
}

/** Creates the base metadata row for a provider match; concurrent requests for the same match share one create. */
export async function ensureBaseMetadata(state: MetadataProcessState, input: BaseMetadataInput): Promise<CreatedProviderMetadata> {
	const { type, providerName, providerMetadata, matchScore, providers } = input;
	const key = `${providerName}:${type}:${providerMetadata.externalId}`;

	return await state.baseMetadataProcesses.run(key, () =>
		createFromProvider({ type, providerName, providerMetadata, matchScore, providers }),
	);
}

/** Turns an aggregated provider match into a base row and processes it. */
export async function processAggregatedMatch(
	state: MetadataProcessState,
	type: "movie" | "tv_show",
	parsed: MediaIdentity,
	aggregated: AggregatedMetadata,
	options: Pick<TvProcessOptions, "scheduling" | "language">,
): Promise<MetadataProcessResult | undefined> {
	const base = await ensureBaseMetadata(state, {
		type,
		providerName: aggregated.primaryProviderId,
		providerMetadata: aggregated.metadata,
		matchScore: aggregated.matchScore,
		providers: aggregated.providers,
	});

	return await processCreatedBase(state, type, parsed, base, { ...options, providers: aggregated.providers });
}

/**
 * Processes a base row the provider or sidecar path just ensured: the movie or episode entries, then the
 * artwork once the match is persisted. Artwork is queued only for rows created by this call.
 */
export async function processCreatedBase(
	state: MetadataProcessState,
	type: "movie" | "tv_show",
	parsed: MediaIdentity,
	base: CreatedProviderMetadata,
	options: Omit<TvProcessOptions, "metadataStableKey">,
): Promise<MetadataProcessResult | undefined> {
	const result =
		type === "movie"
			? await processMovieMetadata(state, base.metadataId, base.metadataStableKey)
			: await processTVShowMetadata(state, base.metadataId, parsed, base.metadata, {
					...options,
					metadataStableKey: base.metadataStableKey,
				});

	if (result) await enqueueBaseMetadataImages(state, base, options.scheduling);

	return result;
}

async function enqueueBaseMetadataImages(
	state: MetadataProcessState,
	base: CreatedProviderMetadata,
	scheduling: TvProcessOptions["scheduling"],
): Promise<void> {
	if (!base.created) return;

	await state.imageEnqueueProcesses.run(base.metadataId, async () => {
		await state.enqueueImages(
			{
				kind: "metadata",
				metadataId: base.metadataId,
				urls: [
					{ type: "poster", url: base.metadata.posterPath },
					{ type: "backdrop", url: base.metadata.backdropPath },
				],
			},
			scheduling,
		);

		await processPersonImages(base.personImages, ({ personId, url }) =>
			state.enqueueImages({ kind: "person", personId, urls: url }, scheduling),
		);
		pluginEventBus.publish("metadata.saved", { metadataId: base.metadataId });
	});
}
