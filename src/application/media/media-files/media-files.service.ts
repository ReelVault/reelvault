import type {
	CreateMediaMarker,
	FieldsQuery,
	MediaFileAuditResponse,
	MediaFileAuditStatus,
	MediaFileFilters,
	MediaFileSorting,
	MediaFileWithRelation,
	MediaMarker,
	PaginatedResponse,
	PaginationQuery,
	PlaybackArtifact,
	ReassignMediaFile,
	SelectFields,
	UpdateMediaFile,
} from "@reelvault/sdk/common";
import { MediaFileAuditResponseSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/application/admin/admin-audit.service";
import { fallbackEpisodeExternalId, fallbackSeasonExternalId } from "@/application/catalog/catalog.utils";
import { createFromProvider, processPersonImages } from "@/application/catalog/metadata/metadata-create.utils";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataPersistenceRepository } from "@/database/repositories/metadata-persistence.repository";
import { moviesRepository } from "@/database/repositories/movies.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { workerJobRepository } from "@/database/repositories/worker.repository";
import { QueryFields } from "@/database/utils/fields";
import { toPublicMarker } from "@/database/utils/media-marker.mapper";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { errorMessage, InternalError, NotFoundError, ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { PromiseUtils } from "@/utils/promise.utils";
import { runMediaCleanup } from "@/utils/server-data.utils";
import { mapLibraryType } from "@/utils/type.utils";
import { enqueueMediaFileAuditReport } from "@/workers/definitions/media/media-file-audit.worker";
import { enqueueAllMediaFilesRefresh } from "@/workers/definitions/media/media-files-refresh-all.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped";
import { workerService } from "@/workers/worker.service";
import { mediaFileRefreshService } from "./refresh-media-file.operation";

// Concurrency guard for on-demand ffmpeg/ffprobe integrity scans triggered from the API.
// Each permit is an ffmpeg decode — derived from measured CPU capacity
// (admin's scanning.concurrency override is honored inside the getter).
const scanSemaphore = PromiseUtils.createSemaphore(() => systemResourcesService.getScannerConcurrency());

interface MediaFileScanResult {
	exists: boolean;
	readable: boolean;
	sizeBytes: number | null;
	probeSuccess: boolean;
	probeError: string | null;
	decodeSuccess: boolean;
	decodeError: string | null;
	isEnabled: boolean;
}

class MediaService extends BaseService {
	/**
	 * Validated audit reports by operation id. A completed operation's result is
	 * immutable, but the client polls it repeatedly; without this, every poll
	 * re-parsed and re-validated the whole report against the TypeBox schema.
	 */
	private readonly auditResultCache = new MemoryCache<MediaFileAuditResponse>({ ttlMs: -1, maxSize: 8, name: "media-file-audit-results" });

	constructor() {
		super("MediaService");
	}

	async getAll<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & MediaFileFilters & MediaFileSorting,
	): Promise<PaginatedResponse<SelectFields<MediaFileWithRelation, F>>> {
		return await this.safeExecute("getAll", async () => await mediaRepository.findPage(query));
	}

	async getById<F extends string>(mediaFileId: string, query?: FieldsQuery<F>): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await this.safeExecute("getById", async () => {
			const media = await mediaRepository.findByIdForRead(mediaFileId, query);

			this.assertExists(media, "MediaFile", mediaFileId);

			return media;
		});
	}

	async listArtifacts(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<PlaybackArtifact[]> {
		return await this.safeExecute("listArtifacts", async () => {
			if (!options?.skipExistsCheck) await this.assertMediaFileExists(mediaFileId);

			return await mediaArtifactsService.list(mediaFileId);
		});
	}

	async getArtifact(mediaFileId: string, artifactId: string): Promise<{ artifact: PlaybackArtifact; file: Blob }> {
		return await this.safeExecute("getArtifact", async () => {
			const artifact = await mediaArtifactsService.findFile(mediaFileId, artifactId);
			this.assertExists(artifact, "PlaybackArtifact", artifactId);

			return artifact;
		});
	}

	async listMarkers(mediaFileId: string, options?: { skipExistsCheck?: boolean }): Promise<MediaMarker[]> {
		return await this.safeExecute("listMarkers", async () => {
			if (!options?.skipExistsCheck) await this.assertMediaFileExists(mediaFileId);

			const markers = await mediaMarkersRepository.findByMediaFileId(mediaFileId);

			return markers.map((item) => toPublicMarker(item));
		});
	}

	async listAllMarkers(limit?: number): Promise<MediaMarker[]> {
		return await this.safeExecute("listAllMarkers", async () => {
			// SQL-side LIMIT — fetching every marker row to slice in JS would read
			// the whole table on a user-triggerable route.
			const markers = await mediaMarkersRepository.findAll(limit && limit > 0 ? limit : undefined);

			return markers.map((item) => toPublicMarker(item));
		});
	}

	async setMarkers(
		mediaFileId: string,
		markers: readonly CreateMediaMarker[],
		options?: { pluginId?: string; source?: "automatic" | "manual" | "plugin" },
		context?: AdminAuditContext,
	): Promise<MediaMarker[]> {
		return await this.safeExecute("setMarkers", async () => {
			// Server-owned semantic validation (moved out of the SDK client).
			const invalid = markers.find((marker) => marker.endSeconds < marker.startSeconds);
			if (invalid) throw new ValidationError(`Marker end must not precede its start (${invalid.type})`);

			const [mediaFileExists, before] = await Promise.all([
				mediaRepository.isExists({ primaryId: mediaFileId }),
				mediaMarkersRepository.findByMediaFileId(mediaFileId),
			]);
			this.assertFound(mediaFileExists, "MediaFile", mediaFileId);
			const saved = await mediaMarkersRepository.replaceMarkersForMediaFile(mediaFileId, markers, options);
			const after = saved.map((item) => toPublicMarker(item));

			recordAuditSafe(
				{
					action: "update",
					resourceType: "media_markers",
					resourceId: mediaFileId,
					before: before.map((item) => toPublicMarker(item)),
					after,
					context,
				},
				this.logger,
			);

			return after;
		});
	}

	async deleteMarkers(mediaFileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await this.safeExecute("deleteMarkers", async () => {
			await this.assertMediaFileExists(mediaFileId);
			const before = await mediaMarkersRepository.findByMediaFileId(mediaFileId);
			await mediaMarkersRepository.deleteByMediaFileId(mediaFileId);

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "media_markers",
					resourceId: mediaFileId,
					before: before.map((item) => toPublicMarker(item)),
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}

	async update<F extends string>(
		mediaFileId: string,
		body: UpdateMediaFile,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await this.safeExecute("update", async () =>
			auditedUpdate({
				logger: this.logger,
				resourceType: "media_file",
				resourceId: mediaFileId,
				entityName: "MediaFile",
				before: () => mediaRepository.findByIdForRead(mediaFileId, auditBeforeFields(body, query)),
				update: () => mediaRepository.updateAndRead(mediaFileId, body, query),
				context,
			}),
		);
	}

	async refresh(mediaFileId: string, context?: AdminAuditContext) {
		return await this.safeExecute("refresh", async () => {
			const mediaFile = await mediaRepository.findIdentity(mediaFileId);
			this.assertExists(mediaFile, "MediaFile", mediaFileId);

			const enqueued = await enqueueDeduped({
				// Only the technical refresh gates the whole request: a metadata refresh
				// already running must not swallow the probe/marker refresh — `queue`
				// reuses the active metadata task and still schedules the technical one.
				targets: [{ workerId: "media-file-technical-refresh", dedupeKey: mediaFileId }],
				type: "media-file-refresh",
				reference: { type: "media-file", id: mediaFileId },
				label: "media file refresh",
				enqueue: async (operationId) => {
					const queued = await mediaFileRefreshService.queue(mediaFileId, { operationId }, mediaFile.metadataId);

					return { operationId: queued.technicalTask.operationId };
				},
			});

			recordAuditSafe(
				{
					action: "update",
					resourceType: "media_file_refresh",
					resourceId: mediaFileId,
					after: { operationId: enqueued.operationId },
					context,
				},
				this.logger,
			);

			return enqueued;
		});
	}

	async refreshAll(context?: AdminAuditContext) {
		return await this.safeExecute("refreshAll", async () => {
			const enqueued = await enqueueDeduped({
				targets: [{ workerId: "media-files-refresh-all", dedupeKey: "media-files-refresh-all" }],
				type: "media-files-refresh",
				reference: { type: "media-files", id: "all" },
				label: "all media files refresh",
				enqueue: (operationId) => enqueueAllMediaFilesRefresh({ operationId }),
			});

			recordAuditSafe(
				{
					action: "update",
					resourceType: "media_files_refresh_all",
					after: { operationId: enqueued.operationId },
					context,
				},
				this.logger,
			);

			return enqueued;
		});
	}

	async scan(mediaFileId: string, options?: { durationSeconds?: number | null } | null): Promise<MediaFileScanResult> {
		return await scanSemaphore.run(async () => {
			return await this.safeExecute("scan", async () => {
				const mediaFile = await mediaRepository.findByPrimaryId({
					primaryId: mediaFileId,
					fields: QueryFields.parse({ fields: "id,filePath,isEnabled" }),
				});
				this.assertExists(mediaFile, "MediaFile", mediaFileId);

				const filePath = mediaFile.filePath;
				let exists = false;
				let readable = false;
				let sizeBytes: number | null = null;

				try {
					const stats = await FileUtils.getStats(filePath);
					if (stats) {
						exists = true;
						readable = stats.isFile();
						sizeBytes = stats.size;
					}
				} catch {
					// File not found or not accessible
				}

				if (!exists) {
					return {
						isEnabled: false,
						exists: false,
						readable: false,
						sizeBytes: null,
						probeSuccess: false,
						probeError: "File does not exist on disk",
						decodeSuccess: false,
						decodeError: "File does not exist on disk",
					};
				}

				let probeSuccess = false;
				let probeError: string | null = null;
				try {
					const probe = await videoParser.probe(filePath);
					if (probe) {
						probeSuccess = true;
					} else {
						probeError = "ffprobe returned no data";
					}
				} catch (err) {
					probeError = errorMessage(err);
				}

				let decodeSuccess = false;
				let decodeError: string | null = null;
				try {
					const args = ["-v", "error"];
					const scanDuration = options?.durationSeconds === undefined ? 60 : options.durationSeconds;
					if (scanDuration && scanDuration > 0) {
						args.push("-t", String(scanDuration));
					}

					args.push("-i", filePath, "-f", "null", "-");

					const ffmpegResult = await ffMpegService.runToCompletion(args, { stdout: "ignore" });
					if (ffmpegResult.exitCode === 0) {
						decodeSuccess = true;
					} else {
						decodeError =
							ffmpegResult.stderr === "" ? `ffmpeg exited with code ${ffmpegResult.exitCode ?? "unknown"}` : ffmpegResult.stderr;
					}
				} catch (err) {
					decodeError = errorMessage(err);
				}

				// `exists` was already asserted by the early return above.
				const hasErrors = !(readable && probeSuccess && decodeSuccess);
				let isEnabled = mediaFile.isEnabled;

				const shouldBeEnabled = !hasErrors;
				if (mediaFile.isEnabled !== shouldBeEnabled) {
					await mediaRepository.update({ primaryId: mediaFileId, values: { isEnabled: shouldBeEnabled } });
					isEnabled = shouldBeEnabled;
				}

				return {
					exists,
					readable,
					sizeBytes,
					probeSuccess,
					probeError,
					decodeSuccess,
					decodeError,
					isEnabled,
				};
			});
		});
	}

	private async assertMediaFileExists(mediaFileId: string): Promise<void> {
		const mediaFileExists = await mediaRepository.isExists({ primaryId: mediaFileId });
		this.assertFound(mediaFileExists, "MediaFile", mediaFileId);
	}

	/**
	 * Fetches provider details and persists a brand-new metadata record for a
	 * reassign-by-provider request, then refreshes its artwork.
	 */
	private async createReassignMetadataFromProvider(
		providerId: string,
		externalId: string,
		mediaType: "movie" | "tv_show",
	): Promise<string> {
		const providerMetadata = await providerService.fetchDetailsByProvider(providerId, mediaType, externalId);
		if (!providerMetadata) {
			throw new NotFoundError("Provider details not found", {
				code: "media_file.provider_details_not_found",
				params: { providerId },
			});
		}

		const result = await createFromProvider({
			type: mediaType,
			providerName: providerId,
			providerMetadata,
			matchScore: 1.0,
		});
		const targetMetadataId = result.metadataId;

		await imageProcessingService.replaceProviderArtwork(targetMetadataId, providerMetadata);
		await processPersonImages(result.personImages, ({ personId, url }) => imageProcessingService.processPerson(personId, url, true));

		pluginEventBus.publish("metadata.saved", { metadataId: targetMetadataId });

		return targetMetadataId;
	}

	/** Validates that an existing metadata target matches the media file's type. */
	private async assertReassignTargetMetadata(targetMetadataId: string, mediaType: "movie" | "tv_show"): Promise<string> {
		const existingMetadata = await metadataRepository.findByIdForRead(targetMetadataId, {
			fields: "id,type,title",
		});
		this.assertExists(existingMetadata, "Metadata", targetMetadataId);
		if (existingMetadata.type !== mediaType) {
			throw new ValidationError("Metadata type mismatch", {
				code: "media_file.metadata_type_mismatch",
				params: { expectedType: mediaType, actualType: existingMetadata.type },
			});
		}

		return existingMetadata.id;
	}

	/** Resolves the reassign target id from provider details or an existing metadata record. */
	private async resolveReassignTarget(body: ReassignMediaFile, mediaType: "movie" | "tv_show"): Promise<string> {
		if (body.providerId && body.externalId) {
			return await this.createReassignMetadataFromProvider(body.providerId, body.externalId, mediaType);
		}

		if (body.targetMetadataId) return await this.assertReassignTargetMetadata(body.targetMetadataId, mediaType);

		throw new ValidationError("targetMetadataId or provider details are required", {
			code: "media_file.target_required",
		});
	}

	private async resolveMovieAnchor(targetMetadataId: string): Promise<string> {
		const movie = await moviesRepository.findOrCreateByMetadataId({ metadataId: targetMetadataId });
		if (!movie) throw new InternalError("Failed to create movie record", { code: "media_file.movie_create_failed" });

		return movie.id;
	}

	private async resolveEpisodeAnchorById(episodeId: string, targetMetadataId: string): Promise<string> {
		const episode = await episodesRepository.findByIdForRead(episodeId, {
			fields: "id,seasonId",
		});
		this.assertExists(episode, "Episode", episodeId);
		const season = await seasonsRepository.findByIdForRead(episode.seasonId, {
			fields: "id,metadataId",
		});
		if (!season || season.metadataId !== targetMetadataId) {
			throw new ValidationError("Selected episode does not belong to the target series", {
				code: "media_file.episode_mismatch",
			});
		}

		return episode.id;
	}

	private async resolveEpisodeAnchorByNumbers(targetMetadataId: string, seasonNumber: number, episodeNumber: number): Promise<string> {
		const targetMeta = await metadataRepository.findByIdForRead(targetMetadataId, { fields: "id,stableKey" });
		const seasonInfo = {
			externalId: fallbackSeasonExternalId(targetMetadataId, seasonNumber),
			seasonNumber,
		};
		const episodeInfo = {
			externalId: fallbackEpisodeExternalId(targetMetadataId, seasonNumber, episodeNumber),
			seasonNumber,
			episodeNumber,
		};
		const persisted = await metadataPersistenceRepository.createSeasonAndEpisode({
			metadataId: targetMetadataId,
			metadataStableKey: targetMeta?.stableKey,
			seasonInfo,
			episodeInfo,
		});
		if (!persisted?.episode) throw new InternalError("Failed to create episode record", { code: "media_file.episode_create_failed" });

		return persisted.episode.id;
	}

	/** Anchors the media file to a movie record or a concrete episode of the target series. */
	private async resolveReassignAnchor(
		mediaType: "movie" | "tv_show",
		body: ReassignMediaFile,
		targetMetadataId: string,
	): Promise<{ movieId: string | null; episodeId: string | null }> {
		if (mediaType === "movie") return { movieId: await this.resolveMovieAnchor(targetMetadataId), episodeId: null };

		if (body.episodeId) return { movieId: null, episodeId: await this.resolveEpisodeAnchorById(body.episodeId, targetMetadataId) };

		if (body.seasonNumber !== undefined && body.episodeNumber !== undefined) {
			return {
				movieId: null,
				episodeId: await this.resolveEpisodeAnchorByNumbers(targetMetadataId, body.seasonNumber, body.episodeNumber),
			};
		}

		throw new ValidationError("Episode selection required for a series", { code: "media_file.episode_required" });
	}

	async reassign<F extends string>(
		mediaFileId: string,
		body: ReassignMediaFile,
		query?: FieldsQuery<F>,
		context?: AdminAuditContext,
	): Promise<SelectFields<MediaFileWithRelation, F>> {
		return await this.safeExecute("reassign", async () => {
			const mediaFile = await mediaRepository.findByIdForRead(mediaFileId, {
				fields: "id,libraryId,metadataId,movieId,episodeId,isDefault,filePath,fileName",
			});
			this.assertExists(mediaFile, "MediaFile", mediaFileId);

			// Only library.type is read here — the default fetch would run the
			// library stats/path aggregates for a single string comparison.
			const library = await librariesRepository.findByIdForRead(mediaFile.libraryId, { fields: "id,type" });
			if (!library) {
				throw new NotFoundError("Library not found for this media file", {
					code: "media_file.library_not_found",
					params: { libraryId: mediaFile.libraryId },
				});
			}

			const mediaType = mapLibraryType(library.type);
			const targetMetadataId = await this.resolveReassignTarget(body, mediaType);
			const { movieId: targetMovieId, episodeId: targetEpisodeId } = await this.resolveReassignAnchor(mediaType, body, targetMetadataId);

			// Ensure `isDefault` uniqueness atomically: a concurrent reassign to the
			// same movie/episode must not leave two defaults behind.
			await mediaRepository.reassign({
				mediaFileId,
				metadataId: targetMetadataId,
				movieId: targetMovieId,
				episodeId: targetEpisodeId,
			});

			recordAuditSafe(
				{
					action: "update",
					resourceType: "media_file_reassign",
					resourceId: mediaFileId,
					before: {
						metadataId: mediaFile.metadataId,
						movieId: mediaFile.movieId,
						episodeId: mediaFile.episodeId,
					},
					after: {
						metadataId: targetMetadataId,
						movieId: targetMovieId,
						episodeId: targetEpisodeId,
					},
					context,
				},
				this.logger,
			);

			const updated = await mediaRepository.findByIdForRead(mediaFileId, query);
			this.assertExists(updated, "MediaFile", mediaFileId);

			return updated;
		});
	}

	/** Queues the full-catalog audit as a background operation (route returns 202). */
	async queueAudit(context?: AdminAuditContext): Promise<{ success: true; operationId: string; status: "pending" }> {
		return await this.safeExecute("queueAudit", async () => {
			const enqueued = await enqueueDeduped({
				targets: [{ workerId: "media-files-audit", dedupeKey: "media-files-audit:all" }],
				type: "media-files-audit",
				reference: { type: "media-files", id: "all" },
				label: "media file audit",
				enqueue: (operationId) => enqueueMediaFileAuditReport({ operationId }),
			});

			recordAuditSafe(
				{
					action: "create",
					resourceType: "media_file_audit",
					resourceId: "all",
					after: { operationId: enqueued.operationId, status: "pending" },
					context,
				},
				this.logger,
			);

			return enqueued;
		});
	}

	/** Polls an audit operation; `result` is populated once it completes. */
	async getAuditStatus(operationId: string): Promise<MediaFileAuditStatus> {
		return await this.safeExecute("getAuditStatus", async () => {
			const operation = await workerService.getOperation(operationId);
			if (operation?.type !== "media-files-audit") {
				throw new NotFoundError("Audit operation not found", { code: "media_file.audit_not_found" });
			}

			let result: MediaFileAuditResponse | null = null;
			if (operation.status === "completed") {
				const cached = this.auditResultCache.get(operationId);
				if (cached) {
					result = cached;
				} else {
					const [job] = await workerJobRepository.findByOperation(operationId, 1);
					if (job?.result) {
						const parsed: unknown = JSON.parse(job.result);
						if (Value.Check(MediaFileAuditResponseSchema, parsed)) {
							result = parsed;
							this.auditResultCache.set(operationId, parsed);
						}
					}
				}
			}

			return {
				status: operation.status,
				progressPercent: operation.progressPercent,
				result,
			};
		});
	}

	async delete(mediaFileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await this.safeExecute("delete", async () => {
			// getById already asserts existence (404) — no redundant second check needed.
			const mediaFile = await this.getById(mediaFileId, { fields: "id" });
			const cleanup = await mediaRepository.deleteAndGetCleanup(mediaFileId);
			await runMediaCleanup(cleanup);

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "media_file",
					resourceId: mediaFileId,
					before: mediaFile,
					context,
				},
				this.logger,
			);

			return { success: true };
		});
	}
}

export const mediaService = new MediaService();
