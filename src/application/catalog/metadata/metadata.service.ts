import type {
	CreateMetadata,
	FieldsQuery,
	MetadataDetailsViewResponse,
	MetadataFilters,
	MetadataImageOption,
	MetadataSorting,
	MetadataWithRelation,
	PaginatedResponse,
	PaginationQuery,
	SeasonWithEpisodes,
	SelectFields,
	SelectMetadataImage,
	UpdateMetadata,
} from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { clearEtagBodyCache } from "@/api/utils/etag.utils";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/application/admin/admin-audit.service";
import { pluginsService } from "@/application/plugins.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { type MetadataRootRow, metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataMergeRepository } from "@/database/repositories/metadata-merge.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { clearSimilarIdsCache } from "@/database/repositories/metadata-recommendations";
import { searchGlobal } from "@/database/repositories/metadata-search";
import { playbackRepository } from "@/database/repositories/playback.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { userRatingsRepository } from "@/database/repositories/user-ratings.repository";
import { watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { imageUploadService } from "@/modules/images/image-upload.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { groupBy, toMap } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { errorMessage, InternalError, NotFoundError, ValidationError } from "@/utils/errors";
import { rankImageOptions } from "@/utils/image-storage.utils";
import { clamp } from "@/utils/math.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { runMediaCleanup } from "@/utils/server-data.utils";
import { findFirstProviderResult, mapProviderLinks } from "../catalog.utils";
import { metadataRefreshService } from "./metadata-refresh.runtime";
import { syncSeasonsAndEpisodes } from "./season-sync.utils";

/** Ids kept in the `metadata_orphans` audit payload (the full set is unbounded). */
const MAX_ORPHAN_AUDIT_IDS = 50;

// Profile-scoped filters never take the profile from the query string — the
// service composites it into the filter value the repository parses. The
// composite breaks the literal union type on purpose: after this point the
// value is opaque and only the repository builder decodes it.
function composeProfileScopedFilter(viewerProfileId: string | undefined, status: string | undefined): string | undefined {
	return viewerProfileId && status ? `${viewerProfileId}\u0000${status}` : undefined;
}

class MetadataService extends BaseService {
	constructor() {
		super("MetadataService");
	}

	/**
	 * Retrieve poster and backdrop image options available from linked providers.
	 * Options are ranked by the provider's own score (best first); unscored
	 * candidates keep their provider order after the scored ones.
	 */ async getImageOptions(metadataId: string): Promise<MetadataImageOption[]> {
		return await this.safeExecute("getImageOptions", async () => {
			const metadata = await metadataRepository.findProviderDetails(metadataId);
			this.assertExists(metadata, "Metadata", metadataId);
			const providers = metadata.providers.filter((provider) => provider.entityType === metadata.type);
			const options = await PromiseUtils.mapConcurrent(
				providers,
				serverConfig.application.metadataImageProviderConcurrency,
				async (provider) =>
					(await pluginsService.fetchProviderImages(provider.name, metadata.type, provider.externalId)).map((image) => ({
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
	async selectImage(metadataId: string, selection: SelectMetadataImage, context?: AdminAuditContext): Promise<{ success: true }> {
		return await this.safeExecute("selectImage", async () => {
			const metadata = await metadataRepository.findProviderDetails(metadataId);
			this.assertExists(metadata, "Metadata", metadataId);
			const providerMap = toMap(metadata.providers, (p) => `${p.name}:${p.entityType}`);
			const provider = providerMap.get(`${selection.providerId}:${metadata.type}`);
			if (!provider) throw new ValidationError("Selected provider is not linked to this metadata");

			// The request body URL is never trusted: only artwork the provider
			// actually offers (re-resolved now) may be downloaded.
			const offered = await pluginsService.fetchProviderImages(provider.name, metadata.type, provider.externalId);
			const isOffered = offered.some((image) => image.type === selection.type && image.url === selection.url);
			if (!isOffered) throw new ValidationError("Selected image is not offered by this provider", { code: "metadata.image_not_offered" });

			await imageProcessingService.replaceMetadataImage(metadataId, selection.type, selection.url);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "metadata_image",
					resourceId: metadataId,
					after: selection,
					context,
				},
				this.logger,
			);

			return { success: true as const };
		});
	}

	/**
	 * Upload a custom poster or backdrop image for a metadata item.
	 */
	async uploadImage(metadataId: string, type: "poster" | "backdrop", file: File, context?: AdminAuditContext): Promise<{ success: true }> {
		return await this.safeExecute("uploadImage", async () => {
			const uploaded = await imageUploadService.upload(file, { ownerType: "metadata", ownerId: metadataId, variant: type });
			await imageProcessingService.replaceMetadataImageWithUpload(metadataId, type, uploaded);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "metadata_image_upload",
					resourceId: metadataId,
					after: { type, fileName: file.name, fileSize: file.size },
					context,
				},
				this.logger,
			);

			return { success: true as const };
		});
	}

	/**
	 * Search titles, people, collections and genres globally.
	 */
	async searchGlobal(query: string, limit = 6) {
		return await this.safeExecute("searchGlobal", async () => {
			const term = query.trim();
			const safeLimit = clamp(limit, 1, 20);
			if (term.length < 2) return { titles: [], people: [], collections: [], genres: [] };

			return await searchGlobal({ term, limit: safeLimit });
		});
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MetadataFilters & MetadataSorting,
		viewerProfileId?: string,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return await this.safeExecute("getAll", async () => {
			// Profile-scoped filters never take the profile from the query string —
			// the service composites it into the filter value the repository parses.
			// The composite breaks the literal union type on purpose: after this point
			// the value is opaque and only the repository builder decodes it.
			const watchedStatus = composeProfileScopedFilter(viewerProfileId, query?.watchedStatus);
			const userRating = composeProfileScopedFilter(viewerProfileId, query?.userRating);

			return await metadataRepository.findPage({
				...query,
				hasMediaFiles: query?.hasMediaFiles ?? true,
				...(watchedStatus ? { watchedStatus } : {}),
				...(userRating ? { userRating } : {}),
			});
		});
	}

	async getById<F extends string>(metadataId: string, query?: FieldsQuery<F>): Promise<SelectFields<MetadataWithRelation, F>> {
		return await this.safeExecute("getById", async () => {
			const metadata = await metadataRepository.findByIdForRead(metadataId, query);

			this.assertExists(metadata, "Metadata", metadataId);

			return metadata;
		});
	}

	/**
	 * Flat metadata row without any relation queries. Use for composite views
	 * whose contract only carries the root row (playback view) — getById would
	 * run the full detail-page relation load for nothing.
	 */
	async getRootsById(metadataId: string): Promise<MetadataRootRow | undefined> {
		return await this.safeExecute("getRootsById", async () => {
			return await metadataRepository.findRootsById(metadataId);
		});
	}

	async getDetailsView(metadataId: string, profileId?: string): Promise<MetadataDetailsViewResponse> {
		return await this.safeExecute("getDetailsView", async () => {
			const metadata = await metadataRepository.findByIdForRead(metadataId);
			this.assertExists(metadata, "Metadata", metadataId);

			const isTv = metadata.type === "tv_show";

			const [seasonsResult, episodesResult, mediaFilesResult, inWatchlist, ratingRecord, isWatchedRecord, progressRows] = await Promise.all(
				[
					isTv ? seasonsRepository.findByMetadataId(metadataId) : Promise.resolve([]),
					isTv ? episodesRepository.findByMetadataIdProjected(metadataId) : Promise.resolve([]),
					// Root rows only — the contract ships MediaFileSchema (no streams), so
					// the per-batch stream/library relation loads would be pure waste.
					mediaRepository.findRootsByMetadataId(metadataId),
					profileId ? watchlistRepository.isWatchlisted(profileId, metadataId) : Promise.resolve(false),
					profileId ? userRatingsRepository.findByProfileAndMetadata(profileId, metadataId) : Promise.resolve(null),
					profileId
						? watchedHistoryRepository
								.isWatched(profileId, metadataId)
								// Degraded reads must be visible — a silent false would present
								// watched state as unwatched.
								.catch((error) => {
									this.logger.warn("Watched-state lookup failed — reporting as unwatched", {
										metadataId,
										profileId,
										error: errorMessage(error),
									});

									return false;
								})
						: Promise.resolve(false),
					profileId
						? playbackRepository.findProgressRows(metadataId, profileId).catch((error) => {
								this.logger.warn("Playback progress lookup failed — reporting as no progress", {
									metadataId,
									profileId,
									error: errorMessage(error),
								});

								return [];
							})
						: Promise.resolve([]),
				],
			);

			const mediaFilesByEpisodeId = groupBy(mediaFilesResult, (m) => m.episodeId);
			const enrichedEpisodes = episodesResult.map((ep) => ({
				...ep,
				mediaFiles: mediaFilesByEpisodeId.get(ep.id) ?? [],
			}));

			const episodesForGrouping: typeof enrichedEpisodes = isTv ? enrichedEpisodes : [];
			const episodesBySeason = groupBy(episodesForGrouping, (ep) => ep.seasonId);
			const seasonsWithEpisodes: SeasonWithEpisodes[] = seasonsResult.map((season) => ({
				...season,
				episodes: episodesBySeason.get(season.id) ?? [],
			}));

			const progress = profileId
				? playbackProgressService.computePlaybackProgress({
						metadata,
						mediaFiles: mediaFilesResult,
						progressRows,
						episodes: episodesResult,
					})
				: null;

			const smartPlay = profileId
				? playbackProgressService.computeSmartPlay({
						metadata,
						mediaFiles: mediaFilesResult,
						progressRows,
						seasons: seasonsResult,
						episodes: episodesResult,
					})
				: null;

			return {
				metadata,
				mediaFiles: mediaFilesResult,
				seasons: seasonsWithEpisodes,
				userState: {
					inWatchlist,
					rating: ratingRecord?.rating ?? null,
					isWatched: isWatchedRecord,
					progress: progress ?? null,
				},
				smartPlay: smartPlay?.suggestion ?? null,
			};
		});
	}

	async create<F extends string>(
		body: CreateMetadata,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await this.safeExecute("create", async () => {
			const result = await metadataRepository.createAndRead(body, query);
			if (!result) throw new InternalError("Metadata creation failed");

			pluginsService.publish("metadata.saved", { metadataId: result.id });

			recordAuditSafe(
				{
					action: "create",
					resourceType: "metadata",
					resourceId: result.id,
					after: result,
					context,
				},
				this.logger,
			);

			return result;
		});
	}

	async update<F extends string>(
		metadataId: string,
		body: UpdateMetadata,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await this.safeExecute("update", async () =>
			auditedUpdate({
				logger: this.logger,
				resourceType: "metadata",
				resourceId: metadataId,
				entityName: "Metadata",
				before: () => metadataRepository.findByIdForRead(metadataId, auditBeforeFields(body, query)),
				update: () => metadataRepository.updateAndRead(metadataId, body, query),
				afterUpdate: () => {
					this.invalidateReadCaches();
					pluginsService.publish("metadata.saved", { metadataId });
					// Keep sidecar documents in sync with the edit (sidecar storage modes).
					sidecarSyncService.scheduleSync(metadataId);
				},
				context,
			}),
		);
	}

	async rematch<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string },
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await this.safeExecute("rematch", async () => {
			const existing = await metadataRepository.findByIdForRead(metadataId, { fields: "id,type" });
			this.assertExists(existing, "Metadata", metadataId);

			const providerMetadata = await pluginsService.fetchProviderDetailsByProvider(body.providerId, existing.type, body.externalId);
			if (!providerMetadata) throw new NotFoundError("Could not fetch metadata details for the specified provider and external ID");

			await metadataPersistenceRepository.rematchProviderMetadata({
				metadataId,
				type: existing.type,
				providerName: body.providerId,
				metadata: providerMetadata,
				matchScore: 1.0,
			});

			await imageProcessingService.replaceProviderArtwork(metadataId, providerMetadata);

			if (existing.type === "tv_show" && providerMetadata.seasons) {
				await syncSeasonsAndEpisodes(metadataId, providerMetadata.seasons);
			}

			this.invalidateReadCaches();
			pluginsService.publish("metadata.saved", { metadataId });
			sidecarSyncService.scheduleSync(metadataId);
			const updated = await metadataRepository.findByIdForRead(metadataId, query);
			this.assertExists(updated, "Metadata", metadataId);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "metadata_rematch",
					resourceId: metadataId,
					before: existing,
					after: { providerId: body.providerId, externalId: body.externalId, updated },
					context,
				},
				this.logger,
			);

			return updated;
		});
	}

	/**
	 * Links an additional provider to an existing title and re-aggregates every
	 * linked provider by priority. Unlike {@link rematch}, the current primary
	 * provider is preserved — the new provider only fills gaps (and adds ratings).
	 */
	async linkProvider<F extends string>(
		metadataId: string,
		body: { providerId: string; externalId: string },
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MetadataWithRelation, F>> {
		return await this.safeExecute("linkProvider", async () => {
			const existing = await metadataRepository.findByIdForRead(metadataId, { fields: "id,type,providers" });
			this.assertExists(existing, "Metadata", metadataId);

			const providerMetadata = await pluginsService.fetchProviderDetailsByProvider(body.providerId, existing.type, body.externalId);
			if (!providerMetadata) throw new NotFoundError("Could not fetch metadata details for the specified provider and external ID");

			await metadataPersistenceRepository.linkProvider(metadataId, existing.type, body.providerId, body.externalId);
			await metadataRefreshService.refresh(metadataId, { prefetchedProviders: { [body.providerId]: providerMetadata } });

			this.invalidateReadCaches();
			const updated = await metadataRepository.findByIdForRead(metadataId, query);
			this.assertExists(updated, "Metadata", metadataId);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "metadata_link_provider",
					resourceId: metadataId,
					before: existing,
					after: { providerId: body.providerId, externalId: body.externalId, updated },
					context,
				},
				this.logger,
			);

			return updated;
		});
	}

	async delete(metadataId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			const metadata = await metadataRepository.findByIdForRead(metadataId);
			this.assertExists(metadata, "Metadata", metadataId);
			const cleanup = await metadataRepository.deleteAndGetCleanup(metadataId);
			await runMediaCleanup(cleanup);

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "metadata",
					resourceId: metadataId,
					before: metadata,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async deleteOrphans(context?: AdminAuditContext): Promise<{ count: number }> {
		return await this.safeExecute("deleteOrphans", async () => {
			// Page the purge so a huge orphan set is never materialized at once, and
			// keep only a bounded sample in the audit payload (the full id list bloated
			// the audit row forever).
			const pageSize = serverConfig.database.queryChunkSize;
			let count = 0;
			const sample: string[] = [];
			for (;;) {
				const orphanIds = await metadataRepository.findOrphanIds(pageSize);
				if (orphanIds.length === 0) break;

				await metadataRepository.deleteOrphansByIds(orphanIds);
				count += orphanIds.length;
				if (sample.length < MAX_ORPHAN_AUDIT_IDS) {
					sample.push(...orphanIds.slice(0, MAX_ORPHAN_AUDIT_IDS - sample.length));
				}

				if (orphanIds.length < pageSize) break;
			}

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "metadata_orphans",
					after: { count, deletedIds: sample, truncated: count > sample.length },
					context,
				},
				this.logger,
			);

			return { count };
		});
	}

	async mergeMetadata(targetId: string, sourceId: string, context?: AdminAuditContext): Promise<{ success: true; targetId: string }> {
		return await this.safeExecute("mergeMetadata", async () => {
			if (targetId === sourceId) throw new ValidationError("Target and source metadata must be different");

			const [target, source] = await Promise.all([
				metadataRepository.findByIdForRead(targetId),
				metadataRepository.findByIdForRead(sourceId),
			]);
			this.assertExists(target, "Metadata (target)", targetId);
			this.assertExists(source, "Metadata (source)", sourceId);
			if (target.type !== source.type)
				throw new ValidationError(`Cannot merge metadata of different types (${target.type} vs ${source.type})`);

			await metadataMergeRepository.merge(targetId, sourceId, target.type);
			// Media files were repointed to the target — rewrite its sidecars.
			sidecarSyncService.scheduleSync(targetId);

			recordAuditSafe(
				{
					action: "update",
					resourceType: "metadata_merge",
					resourceId: targetId,
					before: source,
					after: target,
					context,
				},
				this.logger,
			);

			return { success: true, targetId };
		});
	}

	/** Clears every read cache whose content depends on metadata/relations. */
	private invalidateReadCaches(): void {
		clearEtagBodyCache();
		clearSimilarIdsCache();
	}

	async getSimilar<F extends string>(
		metadataId: string,
		query?: PaginationQuery & FieldsQuery<F>,
		source?: SelectFields<MetadataWithRelation, string>,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		return await this.safeExecute("getSimilar", () => metadataRepository.findSimilarPage(metadataId, query, source));
	}

	async refreshImages(metadataId: string, options: { force?: boolean } = {}): Promise<{ success: boolean }> {
		return await this.safeExecute("refreshImages", async () => {
			const metadata = await metadataRepository.findProviderDetails(metadataId);
			this.assertExists(metadata, "Metadata", metadataId);

			const providersByName = toMap(metadata.providers, (p) => p.name);
			const primaryProvider =
				(metadata.primaryProviderId ? providersByName.get(metadata.primaryProviderId) : undefined) ?? metadata.providers[0];
			if (!primaryProvider) {
				throw new NotFoundError("Metadata provider not found for title");
			}

			const providerMetadata = await pluginsService.fetchProviderDetailsByProvider(
				primaryProvider.name,
				metadata.type,
				primaryProvider.externalId,
			);
			if (!providerMetadata) {
				throw new NotFoundError("Could not fetch details from provider");
			}

			const isForce = options.force ?? true;

			const imagesToProcess: Array<{ type: "poster" | "backdrop"; url?: string }> = [];
			if (providerMetadata.posterPath) imagesToProcess.push({ type: "poster", url: providerMetadata.posterPath });

			if (providerMetadata.backdropPath) imagesToProcess.push({ type: "backdrop", url: providerMetadata.backdropPath });

			if (imagesToProcess.length > 0) {
				await imageProcessingService.processMetadata(metadataId, imagesToProcess, isForce);
			}

			if (metadata.type === "tv_show") {
				await this.syncSeasonEpisodeImages(metadataId, metadata, providerMetadata, isForce);
			}

			this.invalidateReadCaches();
			pluginsService.publish("metadata.saved", { metadataId });

			return { success: true };
		});
	}

	private async syncSeasonEpisodeImages(
		metadataId: string,
		metadata: { providers?: Array<{ name: string; externalId: string }> | undefined; type: string },
		providerMetadata: ProviderMetadataResult,
		isForce: boolean,
	): Promise<void> {
		const providerLinks = mapProviderLinks(metadata.providers ?? []);
		const seasonImages = await syncSeasonsAndEpisodes(metadataId, providerMetadata.seasons, async (seasonNumber) => {
			const providerSeasons = await pluginsService.fetchProviderSeasonFromLinks(providerLinks, seasonNumber);

			return findFirstProviderResult(providerSeasons)?.episodes;
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

		await PromiseUtils.mapConcurrent(imageTasks, systemResourcesService.getSharpConcurrency(), (task) => task());
	}
}

export const metadataService = new MetadataService();
