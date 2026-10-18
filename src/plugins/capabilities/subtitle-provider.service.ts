import type {
	MediaItem,
	SubtitleProviderDownloadRequest,
	SubtitleProviderSearchRequest,
	SubtitleProviderSearchResponse,
} from "@reelvault/sdk/common";
import type { SubtitleDownload } from "@reelvault/sdk/plugin";
import { file } from "bun";
import { pluginSubtitleData, pluginSubtitleSettingsData } from "@/app/plugins/plugin-data.service";
import { serverConfig } from "@/config/server/server.config";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { contentByteSize, createDirectoryOnce, writeFileWithRollback } from "@/plugins/shared/plugin.file-record.utils";
import { DomainError } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { normalizeLower } from "@/utils/type.utils";
import { pluginMediaService } from "./plugin.media";
import { pluginMetadataService } from "./plugin.metadata";

const supportedFormats: ReadonlySet<string> = new Set(serverConfig.plugins.subtitles.supportedFormats);
const leadingDotRegex = /^\./;

class SubtitleProviderService {
	readonly serviceName = "SubtitleProviderService";
	readonly logger = createLogger("SubtitleProviderService");

	/** Creates the subtitle storage directory once per process instead of on every download. */
	private readonly ensureStorageDirectory = createDirectoryOnce(
		serverConfig.paths.subtitles,
		() =>
			new DomainError("internal", `Failed to create subtitle storage directory: ${serverConfig.paths.subtitles}`, {
				code: "plugin.subtitle.storage_error",
			}),
	);

	/** Ids of the subtitle providers the admin has switched off. */
	async disabledProviderIds(): Promise<Set<string>> {
		return new Set(await pluginSubtitleSettingsData.listDisabledIds());
	}

	async setEnabled(providerId: string, enabled: boolean): Promise<void> {
		if (!pluginManager.getSubtitleProvider(providerId)) {
			throw new DomainError("not_found", `Subtitle provider ${providerId} was not found`, { code: "plugin.subtitle.provider_not_found" });
		}

		await pluginSubtitleSettingsData.setEnabled(providerId, enabled);
	}

	async search(request: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]> {
		const media = await this.getMediaItem(request.mediaFileId);
		const disabled = await this.disabledProviderIds();
		const results = await PromiseUtils.mapConcurrent(
			pluginManager.getSubtitleProviders().filter((provider) => !disabled.has(provider.id)),
			serverConfig.plugins.subtitles.providerConcurrency,
			async (provider) => {
				try {
					const providerResults = await provider.search({ media, languages: request.languages });

					return { providerId: provider.id, results: providerResults };
				} catch (error) {
					this.logger.error(`Subtitle provider ${provider.id} failed`, error);

					return null;
				}
			},
		);

		return results.filter((result): result is SubtitleProviderSearchResponse => result !== null);
	}

	async download(providerId: string, request: SubtitleProviderDownloadRequest): Promise<string> {
		const provider = pluginManager.getSubtitleProvider(providerId);
		if (!provider)
			throw new DomainError("not_found", `Subtitle provider ${providerId} was not found`, { code: "plugin.subtitle.provider_not_found" });
		if (await pluginSubtitleSettingsData.isDisabled(providerId)) {
			throw new DomainError("conflict", `Subtitle provider ${providerId} is turned off`, { code: "plugin.subtitle.provider_disabled" });
		}

		await this.getMediaItem(request.mediaFileId);

		const download = await provider.download(request.subtitleId);
		if (!download)
			throw new DomainError("not_found", `Subtitle ${request.subtitleId} was not found in provider ${providerId}`, {
				code: "plugin.subtitle.not_found",
			});

		const format = normalizeFormat(download.format);
		this.assertDownloadSize(download);

		const storagePath = this.storagePath(format);
		await this.ensureStorageDirectory();

		return await writeFileWithRollback(storagePath, download.content, async () => {
			const existing = await pluginSubtitleData.findExternalByMediaFileAndLanguage({
				mediaFileId: request.mediaFileId,
				language: download.language,
			});
			const values = {
				language: download.language,
				label: download.label,
				format,
				type: "external" as const,
				filePath: storagePath,
				streamIndex: null,
				isForced: download.isForced ?? false,
				isHearingImpaired: download.isHearingImpaired ?? false,
			};

			if (existing) {
				await pluginSubtitleData.update({ primaryId: existing.id, values });
				await this.deleteOwnedFile(existing.filePath);

				return existing.id;
			}

			const id = crypto.randomUUID();
			await pluginSubtitleData.insert({ values: { id, mediaFileId: request.mediaFileId, isDefault: false, ...values } });

			return id;
		});
	}

	async getContent(subtitleId: string): Promise<{ contentType: string; file: Blob } | null> {
		const subtitle = await pluginSubtitleData.findByPrimaryId({ primaryId: subtitleId });
		if (subtitle?.type !== "external" || !subtitle.filePath || !this.isOwnedPath(subtitle.filePath)) return null;

		const subtitleFile = file(subtitle.filePath);
		if (!(await subtitleFile.exists())) return null;

		return { contentType: contentTypeForFormat(subtitle.format), file: subtitleFile };
	}

	private async getMediaItem(mediaFileId: string): Promise<MediaItem> {
		const mediaFile = await pluginMediaService.get(mediaFileId);
		if (!mediaFile)
			throw new DomainError("not_found", `Media file ${mediaFileId} was not found`, { code: "plugin.subtitle.media_not_found" });

		const metadata = await pluginMetadataService.get(mediaFile.metadataId);
		if (!metadata)
			throw new DomainError("not_found", `Metadata ${mediaFile.metadataId} was not found`, { code: "plugin.subtitle.metadata_not_found" });

		return {
			id: metadata.id,
			type: metadata.type,
			title: metadata.title,
			year: parseYear(metadata.releaseDate),
			externalIds: metadata.externalIds,
		};
	}

	private storagePath(format: string): string {
		return PathUtils.join(serverConfig.paths.subtitles, `${crypto.randomUUID()}.${format}`);
	}

	private isOwnedPath(path: string): boolean {
		return PathUtils.isSubpath(path, serverConfig.paths.subtitles);
	}

	private async deleteOwnedFile(path: string | null): Promise<void> {
		if (path && this.isOwnedPath(path)) await FileUtils.delete(path);
	}

	private assertDownloadSize(download: SubtitleDownload): void {
		if (contentByteSize(download.content) > serverConfig.plugins.subtitles.maxSizeBytes) {
			throw new DomainError("validation", `Subtitle exceeds the ${serverConfig.plugins.subtitles.maxSizeBytes} byte limit`, {
				code: "plugin.subtitle.too_large",
			});
		}
	}
}

function normalizeFormat(value: string): string {
	const format = normalizeLower(value).replace(leadingDotRegex, "");
	if (!supportedFormats.has(format)) {
		throw new DomainError("validation", `Unsupported subtitle format ${value}`, { code: "plugin.subtitle.unsupported_format" });
	}

	return format;
}

function parseYear(releaseDate: string): number | undefined {
	const year = Number.parseInt(releaseDate.slice(0, 4), 10);

	return Number.isInteger(year) ? year : undefined;
}

function contentTypeForFormat(format: string): "text/vtt" | "text/plain; charset=utf-8" {
	return format === "vtt" ? "text/vtt" : "text/plain; charset=utf-8";
}

export const subtitleProviderService = new SubtitleProviderService();
