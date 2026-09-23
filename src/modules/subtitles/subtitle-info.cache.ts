import type { SubtitleEntity } from "@reelvault/sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { MINUTE } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { MemoryCache } from "@/utils/memory-cache";

export interface SubtitleContentInfo {
	type: string;
	mediaFileId: string;
	streamIndex: number | null;
	format: string;
	mediaFilePath?: string | undefined;
}

type SubtitleInfoRow = Pick<SubtitleEntity, "type" | "mediaFileId" | "streamIndex" | "format">;

interface ServiceDependencies {
	findSubtitle: (id: string) => Promise<SubtitleInfoRow | null | undefined>;
	findMediaFilePath: (mediaFileId: string) => Promise<string | null | undefined>;
}

const defaultDependencies: ServiceDependencies = {
	findSubtitle: async (id) => await subtitlesRepository.findByPrimaryId({ primaryId: id }),
	findMediaFilePath: async (mediaFileId) => (await mediaRepository.findForSubtitleExtraction(mediaFileId))?.filePath ?? null,
};

export class SubtitleInfoCache extends BaseService {
	private readonly dependencies: ServiceDependencies;
	private readonly cache = new MemoryCache<SubtitleContentInfo>({
		ttlMs: 30 * MINUTE,
		maxSize: 1000,
		name: "subtitles-content-info",
	});

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SubtitleInfoCache");
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
		this.assertExists(subtitle, "Subtitle", id);

		let mediaFilePath: string | undefined;
		if (subtitle.type === "embedded") {
			const candidatePath = await this.dependencies.findMediaFilePath(subtitle.mediaFileId);
			this.assertExists(candidatePath, "Media file", subtitle.mediaFileId);
			mediaFilePath = candidatePath;
		}

		return {
			type: subtitle.type,
			mediaFileId: subtitle.mediaFileId,
			streamIndex: subtitle.streamIndex,
			format: subtitle.format,
			mediaFilePath,
		};
	}
}

export const subtitleInfoCache = new SubtitleInfoCache();
