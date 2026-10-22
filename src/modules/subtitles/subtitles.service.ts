import { join } from "node:path";
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
	SubtitleSorting,
	UpdateSubtitleRequest,
} from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { createDirectory } from "@/utils/directory.utils";
import { assertFound, DomainError, errorCodeOf } from "@/utils/domain.errors";
import { deleteFile } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { invalidateResponseBodies } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { resolveSubtitleType, toPublicSubtitle } from "./subtitle.mapper";
import { type SubtitleContent, subtitleContentResolver } from "./subtitle-content.resolver";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import { subtitleFileCleaner } from "./subtitle-file.cleaner";
import { subtitleInfoCache } from "./subtitle-info.cache";
import { detectUploadedSubtitleFormat } from "./subtitle-upload.utils";

export class SubtitlesService {
	readonly serviceName = "SubtitlesService";
	readonly logger = createLogger("SubtitlesService");

	async getAll(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<Subtitle>> {
		return await runSafely(this, "getAll", async () => {
			const result = await subtitlesRepository.findPage(query);

			return { ...result, data: result.data.map(toPublicSubtitle) };
		});
	}

	async getByMediaFileId(mediaFileId: string): Promise<Subtitle[]> {
		return await runSafely(this, "getByMediaFileId", async () => {
			const result = await subtitlesRepository.findByMediaFileId(mediaFileId);

			return result.map((item) => toPublicSubtitle(item));
		});
	}

	async getById(id: string): Promise<Subtitle> {
		return await runSafely(this, "getById", async () => await this.loadSubtitle(id, () => findSubtitle(id)));
	}

	async getProviders(): Promise<SubtitleProviderInfo[]> {
		return await runSafely(this, "getProviders", async () => {
			const disabled = await subtitleProviderService.disabledProviderIds();

			return pluginManager.getSubtitleProviderStatus().map((provider) => ({ ...provider, enabled: !disabled.has(provider.id) }));
		});
	}

	/** Turns a subtitle provider on or off; an off provider is not searched and cannot be downloaded from. */
	async setProviderEnabled(providerId: string, enabled: boolean): Promise<SubtitleProviderInfo> {
		return await runSafely(this, "setProviderEnabled", async () => {
			await subtitleProviderService.setEnabled(providerId, enabled);
			const updated = (await this.getProviders()).find((provider) => provider.id === providerId);
			assertFound(updated, "Subtitle provider", providerId);

			return updated;
		});
	}

	async searchProviders(body: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]> {
		return await runSafely(this, "searchProviders", async () => await subtitleProviderService.search(body));
	}

	async downloadFromProvider(providerId: string, body: SubtitleProviderDownloadRequest): Promise<Subtitle> {
		return await runSafely(this, "downloadFromProvider", async () => {
			const subtitleId = await subtitleProviderService.download(providerId, body);
			const downloaded = await this.loadSubtitle(subtitleId, () => findSubtitle(subtitleId));
			invalidateResponseBodies();

			return downloaded;
		});
	}

	async getContent(id: string, signal?: AbortSignal): Promise<SubtitleContent> {
		return await runSafely(this, "getContent", async () => {
			const info = await subtitleInfoCache.getOrSet(id);

			return await subtitleContentResolver.resolve(id, info, signal);
		});
	}

	async create(body: CreateSubtitleRequest): Promise<Subtitle> {
		return await runSafely(this, "create", async () => {
			const type = resolveSubtitleType(body);
			const created = await this.loadSubtitle(body.mediaFileId, () => subtitlesRepository.createAndRead(body, type));
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

			await createDirectory(serverConfig.paths.subtitles);
			const storedPath = join(serverConfig.paths.subtitles, `${crypto.randomUUID()}.${format}`);
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
				await deleteFile(storedPath);
				throw error;
			}
		});
	}

	async update(id: string, body: UpdateSubtitleRequest): Promise<Subtitle> {
		return await runSafely(this, "update", async () => {
			const previous = await findSubtitle(id);
			// An in-flight extraction read the old row; let it settle before the VTT
			// is dropped, or it can rename the old cues back after the delete.
			await subtitleExtractorService.waitForInFlight(id);

			const updatedEntity = await subtitlesRepository.updateAndRead(id, body);
			assertFound(updatedEntity, "Subtitle", id);
			// Invalidate after the write: a concurrent read between an earlier
			// invalidate and the commit would re-cache the old row for the full TTL.
			subtitleInfoCache.invalidate(id);

			// The extracted VTT is keyed only by the subtitle id, but its content
			// depends on the stream/source/media file — drop it so the next content
			// request re-extracts from the updated row instead of serving stale cues.
			if (previous && (previous.filePath !== updatedEntity.filePath || previous.type !== updatedEntity.type)) {
				// A replaced external file would otherwise leak on disk.
				await subtitleFileCleaner.deleteArtifacts(id, previous);
			} else {
				await subtitleFileCleaner.deleteExtractedVtt(id);
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
			subtitleInfoCache.invalidate(id);
			// Wait for a concurrent extraction so it cannot rename the VTT back
			// after this delete removes it.
			await subtitleExtractorService.waitForInFlight(id);
			const subtitle = await subtitlesRepository.deleteAndReturn(id);
			assertFound(subtitle, "Subtitle", id);
			await subtitleFileCleaner.deleteArtifacts(id, subtitle);
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

function findSubtitle(id: string): Promise<SubtitleEntity | undefined> {
	return subtitlesRepository.findByPrimaryId({ primaryId: id });
}

export const subtitlesService = new SubtitlesService();
