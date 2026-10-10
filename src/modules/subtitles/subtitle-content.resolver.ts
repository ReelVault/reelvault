import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { BaseService } from "@/utils/base-service";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { isBitmapSubtitleFormat } from "./extract/ffmpeg-args";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import type { SubtitleContentInfo } from "./subtitle-info.cache";

export interface SubtitleContent {
	contentType: string;
	file: Blob;
}

interface ServiceDependencies {
	getExternalContent: (id: string) => Promise<SubtitleContent | null | undefined>;
	extractEmbeddedContent: (
		id: string,
		mediaFilePath: string,
		streamIndex: number | null,
		format: string,
		signal?: AbortSignal,
	) => Promise<SubtitleContent | null>;
}

const defaultDependencies: ServiceDependencies = {
	getExternalContent: async (id) => await subtitleProviderService.getContent(id),
	extractEmbeddedContent: (id, mediaFilePath, streamIndex, format, signal) =>
		subtitleExtractorService.extractToVtt(id, mediaFilePath, streamIndex, format, signal),
};

export class SubtitleContentResolver extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SubtitleContentResolver");
		this.dependencies = dependencies;
	}

	async resolve(id: string, info: SubtitleContentInfo, signal?: AbortSignal): Promise<SubtitleContent> {
		if (info.type === "external") {
			const content = await this.dependencies.getExternalContent(id);
			this.assertExists(content, "Subtitle content", id);

			return content;
		}

		if (info.type === "embedded" && isBitmapSubtitleFormat(info.format)) {
			throw new ValidationError("Image-based subtitles cannot be served as text", {
				code: "subtitle.bitmap_unsupported",
				params: { subtitleId: id, format: info.format },
			});
		}

		if (info.type === "embedded" && info.mediaFilePath) {
			const content = await this.dependencies.extractEmbeddedContent(id, info.mediaFilePath, info.streamIndex, info.format, signal);
			this.assertExists(content, "Subtitle content", id);

			return content;
		}

		throw new NotFoundError(`Subtitle content for ${id} was not found`, { code: "subtitle.not_found" });
	}
}

export const subtitleContentResolver = new SubtitleContentResolver();
