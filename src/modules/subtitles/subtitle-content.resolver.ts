import { dirname, resolve } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { isSubpath } from "@/utils/path.utils";
import { isBitmapSubtitleFormat } from "./extract/ffmpeg-args.builder";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import type { SubtitleContentInfo } from "./subtitle-info.cache";

export interface SubtitleContent {
	contentType: string;
	file: Blob;
}

interface ServiceDependencies {
	readExternalContent: (info: SubtitleContentInfo) => Promise<SubtitleContent | null>;
	extractEmbeddedContent: (
		id: string,
		mediaFilePath: string,
		streamIndex: number | null,
		format: string,
		signal?: AbortSignal,
	) => Promise<SubtitleContent | null>;
}

const defaultDependencies: ServiceDependencies = {
	readExternalContent: (info) => readExternalSubtitle(info, serverConfig.paths.subtitles),
	extractEmbeddedContent: (id, mediaFilePath, streamIndex, format, signal) =>
		subtitleExtractorService.extractToVtt(id, mediaFilePath, streamIndex, format, signal),
};

/**
 * Whether an external subtitle file may be served. Only two places hold one: the
 * subtitles root (uploads and provider downloads) and the folder of its own video
 * (sidecars the scanner imported). Any other stored path is never read.
 */
function isServableExternalPath(filePath: string, subtitlesRoot: string, mediaFilePath: string | undefined): boolean {
	if (isSubpath(filePath, subtitlesRoot)) return true;

	return mediaFilePath !== undefined && dirname(resolve(filePath)) === dirname(resolve(mediaFilePath));
}

/** Reads the stored file of an external subtitle, or null when it is missing or outside the servable folders. */
export async function readExternalSubtitle(info: SubtitleContentInfo, subtitlesRoot: string): Promise<SubtitleContent | null> {
	if (!(info.filePath && isServableExternalPath(info.filePath, subtitlesRoot, info.mediaFilePath))) return null;

	const file = Bun.file(info.filePath);
	if (!(await file.exists())) return null;

	return { contentType: info.format === "vtt" ? "text/vtt" : "text/plain; charset=utf-8", file };
}

export class SubtitleContentResolver {
	readonly serviceName = "SubtitleContentResolver";
	readonly logger = createLogger("SubtitleContentResolver");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async resolve(id: string, info: SubtitleContentInfo, signal?: AbortSignal): Promise<SubtitleContent> {
		if (info.type === "external") {
			const content = await this.dependencies.readExternalContent(info);
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
