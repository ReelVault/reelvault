import type { SubtitleEntity } from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { assertFound } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { subtitlesStorage } from "./subtitles.ports";

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
	findSubtitle: async (id) => await subtitlesStorage().findById(id),
	findMediaFilePath: async (mediaFileId) => await subtitlesStorage().findMediaFilePath(mediaFileId),
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

		let mediaFilePath: string | undefined;
		if (subtitle.type === "embedded") {
			const candidatePath = await this.dependencies.findMediaFilePath(subtitle.mediaFileId);
			assertFound(candidatePath, "Media file", subtitle.mediaFileId);
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
