import type {
	CreateSubtitleRequest,
	PaginatedResponse,
	PaginationQuery,
	Subtitle,
	SubtitleEntity,
	SubtitleFilters,
	SubtitleProviderDownloadRequest,
	SubtitleProviderSearchRequest,
	SubtitleProviderSearchResponse,
	SubtitleProviderStatus,
	SubtitleSorting,
	SubtitleType,
	UpdateSubtitleRequest,
} from "@reelvault/sdk/common";
import { pluginsService } from "@/application/plugins.service";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { BaseService } from "@/utils/base-service";
import { resolveSubtitleType, toPublicSubtitle } from "./subtitle.mapper";
import { type SubtitleContentResolver, subtitleContentResolver } from "./subtitle-content.resolver";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import { type SubtitleFileCleaner, subtitleFileCleaner } from "./subtitle-file.cleaner";
import { type SubtitleInfoCache, subtitleInfoCache } from "./subtitle-info.cache";

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
	fileCleaner: Pick<SubtitleFileCleaner, "deleteArtifacts">;
	waitForInFlightExtraction: (subtitleId: string) => Promise<void>;
}

const defaultDependencies: ServiceDependencies = {
	findPage: (query) => subtitlesRepository.findPage(query),
	findByMediaFileId: (mediaFileId) => subtitlesRepository.findByMediaFileId(mediaFileId),
	findById: async (id) => await subtitlesRepository.findByPrimaryId({ primaryId: id }),
	createRow: (body, type) => subtitlesRepository.createAndRead(body, type),
	updateRow: (id, body) => subtitlesRepository.updateAndRead(id, body),
	deleteRow: (id) => subtitlesRepository.deleteAndReturn(id),
	getProviderStatus: () => pluginsService.getSubtitleProviderStatus(),
	searchProviders: (body) => pluginsService.searchSubtitleProviders(body),
	downloadSubtitle: (providerId, body) => pluginsService.downloadSubtitleFromProvider(providerId, body),
	infoCache: subtitleInfoCache,
	contentResolver: subtitleContentResolver,
	fileCleaner: subtitleFileCleaner,
	waitForInFlightExtraction: (subtitleId) => subtitleExtractorService.waitForInFlight(subtitleId),
};

export class SubtitlesService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SubtitlesService");
		this.dependencies = dependencies;
	}

	async getAll(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<Subtitle>> {
		return await this.safeExecute("getAll", async () => {
			const result = await this.dependencies.findPage(query);

			return { ...result, data: result.data.map(toPublicSubtitle) };
		});
	}

	async getByMediaFileId(mediaFileId: string): Promise<Subtitle[]> {
		return await this.safeExecute("getByMediaFileId", async () => {
			const result = await this.dependencies.findByMediaFileId(mediaFileId);

			return result.map((item) => toPublicSubtitle(item));
		});
	}

	async getById(id: string): Promise<Subtitle> {
		return await this.safeExecute("getById", async () => {
			const result = await this.dependencies.findById(id);
			this.assertExists(result, "Subtitle", id);

			return toPublicSubtitle(result);
		});
	}

	async getProviders(): Promise<SubtitleProviderStatus[]> {
		return await this.safeExecute("getProviders", () => this.dependencies.getProviderStatus());
	}

	async searchProviders(body: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]> {
		return await this.safeExecute("searchProviders", async () => await this.dependencies.searchProviders(body));
	}

	async downloadFromProvider(providerId: string, body: SubtitleProviderDownloadRequest): Promise<Subtitle> {
		return await this.safeExecute("downloadFromProvider", async () => {
			const subtitleId = await this.dependencies.downloadSubtitle(providerId, body);
			const result = await this.dependencies.findById(subtitleId);
			this.assertExists(result, "Subtitle", subtitleId);

			return toPublicSubtitle(result);
		});
	}

	async getContent(id: string, signal?: AbortSignal): Promise<{ contentType: string; file: Blob }> {
		return await this.safeExecute("getContent", async () => {
			const info = await this.dependencies.infoCache.getOrSet(id);

			return await this.dependencies.contentResolver.resolve(id, info, signal);
		});
	}

	async create(body: CreateSubtitleRequest): Promise<Subtitle> {
		return await this.safeExecute("create", async () => {
			const type = resolveSubtitleType(body);
			const result = await this.dependencies.createRow(body, type);
			this.assertExists(result, "Subtitle", body.mediaFileId);

			return toPublicSubtitle(result);
		});
	}

	async update(id: string, body: UpdateSubtitleRequest): Promise<Subtitle> {
		return await this.safeExecute("update", async () => {
			this.dependencies.infoCache.invalidate(id);
			const result = await this.dependencies.updateRow(id, body);
			this.assertExists(result, "Subtitle", id);

			return toPublicSubtitle(result);
		});
	}

	async delete(id: string): Promise<{ success: true }> {
		return await this.safeExecute("delete", async () => {
			this.dependencies.infoCache.invalidate(id);
			// Wait for a concurrent extraction so it cannot rename the VTT back
			// after this delete removes it.
			await this.dependencies.waitForInFlightExtraction(id);
			const subtitle = await this.dependencies.deleteRow(id);
			this.assertExists(subtitle, "Subtitle", id);
			await this.dependencies.fileCleaner.deleteArtifacts(id, subtitle);

			return { success: true };
		});
	}
}

export const subtitlesService = new SubtitlesService();
