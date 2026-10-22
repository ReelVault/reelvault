import type { SubtitleEntity } from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { mediaRepository } from "@/repositories/media-files.repository";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { assertFound } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";

export interface SubtitleContentInfo {
	type: string;
	mediaFileId: string;
	streamIndex: number | null;
	format: string;
	/** The stored file of an external subtitle. */
	filePath?: string | null | undefined;
	/** The video the subtitle belongs to: the extraction source of an embedded track, the sidecar folder of an external one. */
	mediaFilePath?: string | undefined;
}

type SubtitleInfoRow = Pick<SubtitleEntity, "type" | "mediaFileId" | "streamIndex" | "format" | "filePath">;

interface ServiceDependencies {
	findSubtitle: (id: string) => Promise<SubtitleInfoRow | null | undefined>;
	findMediaFilePath: (mediaFileId: string) => Promise<string | null | undefined>;
}

const defaultDependencies: ServiceDependencies = {
	findSubtitle: async (id) => await subtitlesRepository.findByPrimaryId({ primaryId: id }),
	findMediaFilePath: async (mediaFileId) => (await mediaRepository.findForSubtitleExtraction(mediaFileId))?.filePath ?? null,
};

export class SubtitleInfoCache {
	readonly serviceName = "SubtitleInfoCache";
	readonly logger = createLogger("SubtitleInfoCache");

	private readonly dependencies: ServiceDependencies;
	private readonly cache = new MemoryCache<SubtitleContentInfo>({
		ttlMs: 30 * MINUTE,
		maxSize: 1000,
		name: "subtitles-content-info",
	});

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	getOrSet(id: string): Promise<SubtitleContentInfo> {
		return this.cache.getOrSet(id, () => this.load(id));
	}

	invalidate(id: string): void {
		this.cache.delete(id);
	}

	private async load(id: string): Promise<SubtitleContentInfo> {
		const subtitle = await this.dependencies.findSubtitle(id);
		assertFound(subtitle, "Subtitle", id);

		const mediaFilePath = await this.dependencies.findMediaFilePath(subtitle.mediaFileId);
		// Extraction needs the video; an external file only uses its folder to tell a sidecar from a stray path.
		if (subtitle.type === "embedded") assertFound(mediaFilePath, "Media file", subtitle.mediaFileId);

		return {
			type: subtitle.type,
			mediaFileId: subtitle.mediaFileId,
			streamIndex: subtitle.streamIndex,
			format: subtitle.format,
			filePath: subtitle.filePath,
			mediaFilePath: mediaFilePath ?? undefined,
		};
	}
}

export const subtitleInfoCache = new SubtitleInfoCache();
