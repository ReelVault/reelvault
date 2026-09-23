import { pluginsService } from "@/application/plugins.service";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
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
	getExternalContent: async (id) => await pluginsService.getSubtitleContent(id),
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

		if (info.type === "embedded" && info.mediaFilePath) {
			const content = await this.dependencies.extractEmbeddedContent(id, info.mediaFilePath, info.streamIndex, info.format, signal);
			this.assertExists(content, "Subtitle content", id);

			return content;
		}

		throw new NotFoundError(`Subtitle content for ${id} was not found`);
	}
}

export const subtitleContentResolver = new SubtitleContentResolver();
