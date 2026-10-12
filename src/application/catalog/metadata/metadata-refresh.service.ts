import type { MetadataCandidate } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { mergeProviderMetadata, type ProviderContribution } from "@/plugins/capabilities/metadata-aggregator";
import { systemResourcesService } from "@/system/system-resources.service";
import { hasEntry, isNotNullish } from "@/utils/array.utils";
import { assertFound, errorMessage } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PromiseUtils } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute";
import type { ImageProcessingData } from "@/workers/definitions/images/image-processing.worker";
import { processPersonImages } from "./metadata-create.utils";
import { applyMetadataCandidate, toMetadataCandidate } from "./metadata-normalization";

export interface RefreshableMetadata {
	id: string;
	type: "movie" | "tv_show";
	providers: ReadonlyArray<{ name: string; externalId: string }>;
	primaryProviderId?: string | null | undefined;
}

type RefreshedMetadataValues = Pick<
	ProviderMetadataResult,
	| "title"
	| "originalTitle"
	| "overview"
	| "tagline"
	| "releaseDate"
	| "status"
	| "budget"
	| "revenue"
	| "popularity"
	| "hasMissingTranslation"
>;

export interface MetadataRefreshDependencies {
	findMetadata(metadataId: string): Promise<RefreshableMetadata | undefined>;
	getLockedFields?(metadataId: string): Promise<string[]>;
	fetchProviderDetails(
		providerId: string,
		type: RefreshableMetadata["type"],
		externalId: string,
		metadataId: string,
	): Promise<ProviderMetadataResult | undefined>;
	transformMetadata(candidate: MetadataCandidate): Promise<MetadataCandidate>;
	updateMetadata(metadataId: string, values: Partial<RefreshedMetadataValues>): Promise<void>;
	syncCredits?(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		lockedFields?: readonly string[],
	): Promise<Array<{ personId: string; url: string }>>;
	syncSeasonsAndEpisodes?(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		providers: ReadonlyArray<{ name: string; externalId: string }>,
	): Promise<
		Array<
			| { kind: "season"; metadataId: string; seasonId: string; seasonNumber: string; urls: string }
			| { kind: "episode"; metadataId: string; episodeId: string; seasonNumber: string; episodeNumber: string; urls: string }
		>
	>;
	syncMetadataRelations?(
		metadataId: string,
		providerName: string,
		metadata: ProviderMetadataResult,
		lockedFields?: readonly string[],
	): Promise<void>;
	publishRefreshed(metadataId: string, correlationId?: string): void;
	enqueueImages?: (data: ImageProcessingData, options?: { operationId?: string | undefined }) => Promise<unknown>;
}

interface RefreshImageScope {
	existing: RefreshableMetadata;
	providerId: string;
	metadata: ProviderMetadataResult;
	lockedFields: string[];
	lockedSet: Set<string>;
	operationId: string | undefined;
}

/** Refreshes persisted provider metadata without performing a new title search. */
export class MetadataRefreshService {
	readonly serviceName = "MetadataRefreshService";
	readonly logger = createLogger("MetadataRefreshService");

	private readonly dependencies: MetadataRefreshDependencies;

	constructor(dependencies: MetadataRefreshDependencies) {
		this.dependencies = dependencies;
	}

	async refresh(
		metadataId: string,
		options: {
			correlationId?: string | undefined;
			operationId?: string | undefined;
			signal?: AbortSignal | undefined;
			/** Already-fetched provider results, keyed by provider id — avoids a second network round-trip after linking a provider. */
			prefetchedProviders?: Readonly<Record<string, ProviderMetadataResult>> | undefined;
		} = {},
	): Promise<{ metadataId: string; providerId: string }> {
		return await runSafely(
			this,
			"refresh",
			async () => {
				options.signal?.throwIfAborted();
				const existing = await this.dependencies.findMetadata(metadataId);
				assertFound(existing, "Metadata", metadataId);

				const lockedFields = (await this.dependencies.getLockedFields?.(metadataId)) ?? [];
				const lockedSet = new Set(lockedFields);

				options.signal?.throwIfAborted();
				const source = await this.fetchFromLinkedProviders(existing, options.prefetchedProviders);
				if (!source) {
					return { metadataId: existing.id, providerId: existing.primaryProviderId ?? "" };
				}

				const candidate = await this.dependencies.transformMetadata(toMetadataCandidate(existing.type, source.providerId, source.metadata));
				const metadata = applyMetadataCandidate(existing.type, source.providerId, source.metadata, candidate);

				options.signal?.throwIfAborted();
				const refreshedValues = toRefreshedMetadataValues(metadata, lockedSet);
				if (hasEntry(refreshedValues)) {
					await this.dependencies.updateMetadata(existing.id, refreshedValues);
				}

				if (this.dependencies.syncMetadataRelations) {
					options.signal?.throwIfAborted();
					await this.dependencies.syncMetadataRelations(existing.id, source.providerId, metadata, lockedFields);
				}

				if (this.dependencies.enqueueImages) {
					options.signal?.throwIfAborted();
					await this.enqueueRefreshImages(this.dependencies.enqueueImages, {
						existing,
						providerId: source.providerId,
						metadata,
						lockedFields,
						lockedSet,
						operationId: options.operationId ?? options.correlationId,
					});
				}

				this.dependencies.publishRefreshed(existing.id, options.correlationId);
				// Refresh changed title/season/episode data — rewrite sidecar docs.
				sidecarSyncService.scheduleSync(existing.id);

				return { metadataId: existing.id, providerId: source.providerId };
			},
			{ logContext: { metadataId, correlationId: options.correlationId, operationId: options.operationId } },
		);
	}

	/** Queues poster, backdrop, person and season/episode artwork for a refreshed title. */
	private async enqueueRefreshImages(
		enqueueImages: NonNullable<MetadataRefreshDependencies["enqueueImages"]>,
		scope: RefreshImageScope,
	): Promise<void> {
		const { existing, providerId, metadata, lockedFields, lockedSet, operationId } = scope;
		const urls: Array<{ type: "poster" | "backdrop"; url?: string }> = [];
		const isImagesLocked = lockedSet.has("images");
		const isPostersLocked = isImagesLocked || lockedSet.has("posters") || lockedSet.has("poster");
		const isBackdropsLocked = isImagesLocked || lockedSet.has("backdrops") || lockedSet.has("backdrop");

		if (!isPostersLocked && metadata.posterPath) urls.push({ type: "poster", url: metadata.posterPath });

		if (!isBackdropsLocked && metadata.backdropPath) urls.push({ type: "backdrop", url: metadata.backdropPath });

		if (urls.length > 0) {
			await enqueueImages({ kind: "metadata", metadataId: existing.id, urls }, { operationId });
		}

		if (this.dependencies.syncCredits) {
			const personImages = await this.dependencies.syncCredits(existing.id, providerId, metadata, lockedFields);
			await processPersonImages(personImages, ({ personId, url }) =>
				enqueueImages({ kind: "person", personId, urls: url }, { operationId }),
			);
		}

		if (existing.type === "tv_show" && this.dependencies.syncSeasonsAndEpisodes) {
			const tvTasks = await this.dependencies.syncSeasonsAndEpisodes(existing.id, providerId, metadata, existing.providers);
			await PromiseUtils.mapConcurrent(tvTasks, systemResourcesService.getIoConcurrency(), (task) => enqueueImages(task, { operationId }));
		}
	}

	private async fetchFromLinkedProviders(
		metadata: RefreshableMetadata,
		prefetchedProviders?: Readonly<Record<string, ProviderMetadataResult>>,
	): Promise<{ providerId: string; metadata: ProviderMetadataResult } | null> {
		const providers = metadata.providers.toSorted((left, right) => {
			if (left.name === metadata.primaryProviderId) return -1;

			if (right.name === metadata.primaryProviderId) return 1;

			return left.name.localeCompare(right.name) || left.externalId.localeCompare(right.externalId);
		});

		// Bounded by the title's provider-link count. If this ever needs a cap, derive it
		// from systemResourcesService rather than adding a setting (AGENTS).
		const results = await Promise.all(
			providers.map(async (provider): Promise<ProviderContribution | null> => {
				try {
					const prefetched = prefetchedProviders?.[provider.name];
					const result =
						prefetched && prefetched.externalId === provider.externalId
							? prefetched
							: await this.dependencies.fetchProviderDetails(provider.name, metadata.type, provider.externalId, metadata.id);
					if (!result) return null;

					if (result.externalId !== provider.externalId) {
						this.logger.warn("Metadata provider returned a mismatched external ID", {
							metadataId: metadata.id,
							providerId: provider.name,
							expectedExternalId: provider.externalId,
							receivedExternalId: result.externalId,
						});

						return null;
					}

					return { providerId: provider.name, externalId: result.externalId, metadata: result };
				} catch (error) {
					this.logger.warn("Metadata provider refresh failed", {
						metadataId: metadata.id,
						providerId: provider.name,
						error: errorMessage(error),
					});

					return null;
				}
			}),
		);

		const contributions = results.filter((item) => isNotNullish(item));
		if (contributions.length === 0) {
			// Every provider failing (outage, rate limit) is an expected anomaly for
			// idempotent background refresh — keep current metadata and let the next
			// scheduled refresh try again instead of failing the job.
			this.logger.warn("No provider returned refresh data — keeping current metadata", { metadataId: metadata.id });

			return null;
		}

		const aggregated = mergeProviderMetadata(contributions);

		return { providerId: aggregated.primaryProviderId, metadata: aggregated.metadata };
	}
}

function toRefreshedMetadataValues(metadata: ProviderMetadataResult, lockedSet: Set<string>): Partial<RefreshedMetadataValues> {
	const values: Partial<RefreshedMetadataValues> = {};
	if (!lockedSet.has("title")) values.title = metadata.title;

	if (!lockedSet.has("originalTitle")) values.originalTitle = metadata.originalTitle;

	if (!lockedSet.has("overview")) values.overview = metadata.overview;

	if (!lockedSet.has("tagline")) values.tagline = metadata.tagline;

	if (!lockedSet.has("releaseDate")) values.releaseDate = metadata.releaseDate;

	if (!lockedSet.has("status")) values.status = metadata.status;

	if (!lockedSet.has("budget")) values.budget = metadata.budget;

	if (!lockedSet.has("revenue")) values.revenue = metadata.revenue;

	values.popularity = metadata.popularity;
	// Re-evaluated on every refresh so a fixed/changed provider translation
	// state clears (or sets) the flag — not just on create/rematch. A provider
	// that omits the field entirely must not clear an existing flag (the admin
	// translation filter would silently lose the title).
	if (metadata.hasMissingTranslation !== undefined) values.hasMissingTranslation = metadata.hasMissingTranslation;

	return values;
}
