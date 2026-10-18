import type {
	BulkRefreshItem,
	BulkSubtitleDeleteResult,
	CreateSubtitleRequest,
	PaginatedResponse,
	PaginationQuery,
	Subtitle,
	SubtitleEntity,
	SubtitleFilters,
	SubtitleProviderDownloadRequest,
	SubtitleProviderInfo,
	SubtitleProviderSearchRequest,
	SubtitleProviderSearchResponse,
	SubtitleProviderStatus,
	SubtitleSorting,
	SubtitleType,
	UpdateSubtitleRequest,
} from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { assertFound, DomainError, errorCodeOf } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { invalidateResponseBodies } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { resolveSubtitleType, toPublicSubtitle } from "./subtitle.mapper";
import { type SubtitleContent, type SubtitleContentResolver, subtitleContentResolver } from "./subtitle-content.resolver";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import { type SubtitleFileCleaner, subtitleFileCleaner } from "./subtitle-file.cleaner";
import { type SubtitleInfoCache, subtitleInfoCache } from "./subtitle-info.cache";
import { detectUploadedSubtitleFormat } from "./subtitle-upload.utils";
import { subtitleProviders, subtitlesStorage } from "./subtitles.ports";

interface ServiceDependencies {
	findPage: (query?: PaginationQuery & SubtitleFilters & SubtitleSorting) => Promise<PaginatedResponse<SubtitleEntity>>;
	findByMediaFileId: (mediaFileId: string) => Promise<SubtitleEntity[]>;
	findById: (id: string) => Promise<SubtitleEntity | null | undefined>;
	createRow: (body: CreateSubtitleRequest, type: SubtitleType) => Promise<SubtitleEntity | null | undefined>;
	updateRow: (id: string, body: UpdateSubtitleRequest) => Promise<SubtitleEntity | null | undefined>;
	deleteRow: (id: string) => Promise<SubtitleEntity | null | undefined>;
	getProviderStatus: () => SubtitleProviderStatus[];
	searchProviders: (body: SubtitleProviderSearchRequest) => Promise<SubtitleProviderSearchResponse[]>;
	downloadSubtitle: (providerId: string, body: SubtitleProviderDownloadRequest) => Promise<string>;
	infoCache: Pick<SubtitleInfoCache, "getOrSet" | "invalidate">;
	contentResolver: Pick<SubtitleContentResolver, "resolve">;
	fileCleaner: Pick<SubtitleFileCleaner, "deleteArtifacts" | "deleteExtractedVtt">;
	waitForInFlightExtraction: (subtitleId: string) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
	findPage: (query) => subtitlesStorage().findPage(query),
	findByMediaFileId: (mediaFileId) => subtitlesStorage().findByMediaFileId(mediaFileId),
	findById: async (id) => await subtitlesStorage().findById(id),
	createRow: (body, type) => subtitlesStorage().createRow(body, type),
	updateRow: (id, body) => subtitlesStorage().updateRow(id, body),
	deleteRow: (id) => subtitlesStorage().deleteRow(id),
	getProviderStatus: () => subtitleProviders().getProviderStatus(),
	searchProviders: (body) => subtitleProviders().search(body),
	downloadSubtitle: (providerId, body) => subtitleProviders().download(providerId, body),
	infoCache: subtitleInfoCache,
	contentResolver: subtitleContentResolver,
	fileCleaner: subtitleFileCleaner,
	waitForInFlightExtraction: (subtitleId) => subtitleExtractorService.waitForInFlight(subtitleId),
};

export class SubtitlesService {
	readonly serviceName = "SubtitlesService";
	readonly logger = createLogger("SubtitlesService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async getAll(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<Subtitle>> {
		return await runSafely(this, "getAll", async () => {
			const result = await this.dependencies.findPage(query);

			return { ...result, data: result.data.map(toPublicSubtitle) };
		});
	}

	async getByMediaFileId(mediaFileId: string): Promise<Subtitle[]> {
		return await runSafely(this, "getByMediaFileId", async () => {
			const result = await this.dependencies.findByMediaFileId(mediaFileId);

			return result.map((item) => toPublicSubtitle(item));
		});
	}

	async getById(id: string): Promise<Subtitle> {
		return await runSafely(this, "getById", async () => await this.loadSubtitle(id, () => this.dependencies.findById(id)));
	}

	async getProviders(): Promise<SubtitleProviderInfo[]> {
		return await runSafely(this, "getProviders", async () => {
			const disabled = await subtitleProviders().disabledProviderIds();

			return this.dependencies.getProviderStatus().map((provider) => ({ ...provider, enabled: !disabled.has(provider.id) }));
		});
	}

	/** Turns a subtitle provider on or off; an off provider is not searched and cannot be downloaded from. */
	async setProviderEnabled(providerId: string, enabled: boolean): Promise<SubtitleProviderInfo> {
		return await runSafely(this, "setProviderEnabled", async () => {
			await subtitleProviders().setEnabled(providerId, enabled);
			const updated = (await this.getProviders()).find((provider) => provider.id === providerId);
			assertFound(updated, "Subtitle provider", providerId);

			return updated;
		});
	}

	async searchProviders(body: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]> {
		return await runSafely(this, "searchProviders", async () => await this.dependencies.searchProviders(body));
	}

	async downloadFromProvider(providerId: string, body: SubtitleProviderDownloadRequest): Promise<Subtitle> {
		return await runSafely(this, "downloadFromProvider", async () => {
			const subtitleId = await this.dependencies.downloadSubtitle(providerId, body);
			const downloaded = await this.loadSubtitle(subtitleId, () => this.dependencies.findById(subtitleId));
			invalidateResponseBodies();

			return downloaded;
		});
	}

	async getContent(id: string, signal?: AbortSignal): Promise<SubtitleContent> {
		return await runSafely(this, "getContent", async () => {
			const info = await this.dependencies.infoCache.getOrSet(id);

			return await this.dependencies.contentResolver.resolve(id, info, signal);
		});
	}

	async create(body: CreateSubtitleRequest): Promise<Subtitle> {
		return await runSafely(this, "create", async () => {
			const type = resolveSubtitleType(body);
			const created = await this.loadSubtitle(body.mediaFileId, () => this.dependencies.createRow(body, type));
			invalidateResponseBodies();

			return created;
		});
	}

	/** Stores an SRT, WebVTT or ASS file as an external subtitle track of the media file; the stored copy is removed if the track cannot be created. */
	async upload(body: { mediaFileId: string; language: string; label?: string | undefined }, file: File): Promise<Subtitle> {
		return await runSafely(this, "upload", async () => {
			const text = await file.text();
			const format = detectUploadedSubtitleFormat(file.name, text);
			if (!format) {
				throw new DomainError("validation", "Uploaded file is not a readable SRT, WebVTT or ASS subtitle", {
					code: "subtitle.invalid_upload",
				});
			}

			await DirUtils.create(serverConfig.paths.subtitles);
			const storedPath = PathUtils.join(serverConfig.paths.subtitles, `${crypto.randomUUID()}.${format}`);
			await Bun.write(storedPath, text);

			try {
				return await this.create({
					mediaFileId: body.mediaFileId,
					language: body.language,
					format,
					sourcePath: storedPath,
					...(body.label === undefined ? {} : { label: body.label }),
				});
			} catch (error) {
				await FileUtils.delete(storedPath);
				throw error;
			}
		});
	}

	async update(id: string, body: UpdateSubtitleRequest): Promise<Subtitle> {
		return await runSafely(this, "update", async () => {
			const previous = await this.dependencies.findById(id);
			this.dependencies.infoCache.invalidate(id);

			const updatedEntity = await this.dependencies.updateRow(id, body);
			assertFound(updatedEntity, "Subtitle", id);

			// The extracted VTT is keyed only by the subtitle id, but its content
			// depends on the stream/source/media file — drop it so the next content
			// request re-extracts from the updated row instead of serving stale cues.
			if (previous && (previous.filePath !== updatedEntity.filePath || previous.type !== updatedEntity.type)) {
				// A replaced external file would otherwise leak on disk.
				await this.dependencies.fileCleaner.deleteArtifacts(id, previous);
			} else {
				await this.dependencies.fileCleaner.deleteExtractedVtt(id);
			}

			// Cached subtitle lists/detail (60-300 s) must not outlive the write.
			invalidateResponseBodies();

			return toPublicSubtitle(updatedEntity);
		});
	}

	/** Removes the listed subtitles one after another; a failing id reports its code and the rest still go through. */
	async bulkDelete(ids: string[]): Promise<BulkSubtitleDeleteResult> {
		return await runSafely(this, "bulkDelete", async () => {
			const results: BulkRefreshItem[] = [];
			for (const id of new Set(ids)) {
				try {
					await this.delete(id);
					results.push({ id, ok: true });
				} catch (error) {
					results.push({ id, ok: false, code: errorCodeOf(error, "subtitle.delete_failed") });
				}
			}

			return { results };
		});
	}

	async delete(id: string): Promise<{ success: true }> {
		return await runSafely(this, "delete", async () => {
			this.dependencies.infoCache.invalidate(id);
			// Wait for a concurrent extraction so it cannot rename the VTT back
			// after this delete removes it.
			await this.dependencies.waitForInFlightExtraction(id);
			const subtitle = await this.dependencies.deleteRow(id);
			assertFound(subtitle, "Subtitle", id);
			await this.dependencies.fileCleaner.deleteArtifacts(id, subtitle);
			invalidateResponseBodies();

			return { success: true };
		});
	}

	/** Loads a subtitle row (asserting it exists under `id`) and maps it to the public contract. */
	private async loadSubtitle(id: string, load: () => Promise<SubtitleEntity | null | undefined>): Promise<Subtitle> {
		const result = await load();
		assertFound(result, "Subtitle", id);

		return toPublicSubtitle(result);
	}
}

export const subtitlesService = new SubtitlesService();
