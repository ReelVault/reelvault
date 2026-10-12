import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { assertFound, DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
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

export class SubtitleContentResolver {
	readonly serviceName = "SubtitleContentResolver";
	readonly logger = createLogger("SubtitleContentResolver");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async resolve(id: string, info: SubtitleContentInfo, signal?: AbortSignal): Promise<SubtitleContent> {
		if (info.type === "external") {
			const content = await this.dependencies.getExternalContent(id);
			assertFound(content, "Subtitle content", id);

			return content;
		}

		if (info.type === "embedded" && isBitmapSubtitleFormat(info.format)) {
			throw new DomainError("validation", "Image-based subtitles cannot be served as text", {
				code: "subtitle.bitmap_unsupported",
				params: { subtitleId: id, format: info.format },
			});
		}

		if (info.type === "embedded" && info.mediaFilePath) {
			const content = await this.dependencies.extractEmbeddedContent(id, info.mediaFilePath, info.streamIndex, info.format, signal);
			assertFound(content, "Subtitle content", id);

			return content;
		}

		throw new DomainError("not_found", `Subtitle content for ${id} was not found`, { code: "subtitle.not_found" });
	}
}

export const subtitleContentResolver = new SubtitleContentResolver();
