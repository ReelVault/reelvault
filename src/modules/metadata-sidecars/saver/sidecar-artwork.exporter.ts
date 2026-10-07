import type { ImageQuality } from "@reelvault/sdk/common";
import { imageRepository } from "@/database/repositories/images.repository";
import { reencodeImage } from "@/integrations/sharp/sharp.actions";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { FileUtils, fileStatSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";
import { assertEpisodeBaseName, formatSeasonNumber } from "./sidecar-path.policy";

const JPEG_QUALITY: ImageQuality = 85;

/**
 * Signatures of the last successful export per target file. Metadata mutations
 * re-save constantly; when both the source and the exported file are unchanged
 * (size + mtime), the re-encode is skipped entirely. A target replaced or a
 * source updated changes its signature and forces a fresh export. Bounded; a
 * deleted target misses and is re-exported.
 */
const exportStamps = new MemoryCache<{ sourceSignature: string; targetSignature: string }>({
	ttlMs: -1,
	maxSize: 2048,
	name: "sidecar-artwork-export",
});

type ReencodeImage = (input: Buffer | string, quality: ImageQuality, signal?: AbortSignal) => Promise<Buffer>;

interface SidecarArtworkExporterDependencies {
	reencodeImage: ReencodeImage;
}

const defaultDependencies: SidecarArtworkExporterDependencies = {
	reencodeImage: (input, quality, signal) => reencodeImage(input, quality, signal),
};

interface TitleArtworkInput {
	readonly metadataId: string;
	readonly directory: string;
}

interface SeasonArtworkInput {
	readonly imageId: string | null | undefined;
	readonly directory: string;
	readonly seasonNumber: number;
}

interface EpisodeArtworkInput {
	readonly imageId: string | null | undefined;
	readonly directory: string;
	readonly videoBaseName: string;
}

export interface SidecarArtworkWriter {
	saveTitleArtwork(input: { metadataId: string; directory: string }): Promise<readonly string[]>;
	saveSeasonArtwork(input: { imageId: string | null | undefined; directory: string; seasonNumber: number }): Promise<readonly string[]>;
	saveEpisodeArtwork(input: { imageId: string | null | undefined; directory: string; videoBaseName: string }): Promise<readonly string[]>;
}

/**
 * Drops artwork files next to the media under the names Kodi, Plex, Jellyfin
 * and our own scanner discover. Actor portraits are deliberately not exported;
 * logos have no persisted source yet.
 */
export class SidecarArtworkExporter extends BaseService implements SidecarArtworkWriter {
	private readonly dependencies: SidecarArtworkExporterDependencies;

	constructor(dependencies: SidecarArtworkExporterDependencies = defaultDependencies) {
		super("SidecarArtworkExporter");
		this.dependencies = dependencies;
	}

	async saveTitleArtwork({ metadataId, directory }: TitleArtworkInput): Promise<readonly string[]> {
		return await this.exportAll(
			this.exportMetadataImage(metadataId, "poster", directory, "poster.jpg"),
			this.exportMetadataImage(metadataId, "backdrop", directory, "fanart.jpg"),
		);
	}

	async saveSeasonArtwork({ imageId, directory, seasonNumber }: SeasonArtworkInput): Promise<readonly string[]> {
		if (!imageId) return [];

		return await this.exportAll(
			this.exportImageFile(imageId, PathUtils.join(directory, `season${formatSeasonNumber(seasonNumber)}-poster.jpg`)),
		);
	}

	async saveEpisodeArtwork({ imageId, directory, videoBaseName }: EpisodeArtworkInput): Promise<readonly string[]> {
		if (!imageId) return [];

		return await this.exportAll(
			this.exportImageFile(imageId, PathUtils.join(directory, `${assertEpisodeBaseName(videoBaseName)}-thumb.jpg`)),
		);
	}

	private async exportAll(...writes: Array<Promise<string | undefined>>): Promise<readonly string[]> {
		// One broken image must not fail the whole sidecar batch.
		const settled = await Promise.allSettled(writes);
		const written: string[] = [];
		for (const result of settled) {
			if (result.status === "fulfilled") {
				if (result.value !== undefined) written.push(result.value);
			} else {
				this.logger.warn("Sidecar artwork export failed", { error: errorMessage(result.reason) });
			}
		}

		return written;
	}

	private async exportMetadataImage(
		metadataId: string,
		imageType: "poster" | "backdrop",
		directory: string,
		fileName: string,
	): Promise<string | undefined> {
		const sourcePath = await imageRepository.findMetadataImagePath(metadataId, imageType);
		if (!sourcePath) return undefined;

		return await this.exportFile(sourcePath, PathUtils.join(directory, fileName));
	}

	private async exportImageFile(imageId: string, targetPath: string): Promise<string | undefined> {
		const image = await imageRepository.findForFileRead(imageId);
		if (!image) return undefined;

		return await this.exportFile(image.localPath, targetPath);
	}

	private async exportFile(sourcePath: string, targetPath: string): Promise<string | undefined> {
		const [sourceStats, targetStats] = await Promise.all([FileUtils.getStats(sourcePath), FileUtils.getStats(targetPath)]);
		const sourceSignature = sourceStats ? fileStatSignature(sourceStats) : "";
		const targetSignature = targetStats ? fileStatSignature(targetStats) : "";
		const cached = exportStamps.get(targetPath);
		// Both files untouched since the last export — nothing to re-encode.
		if (cached && targetSignature !== "" && cached.sourceSignature === sourceSignature && cached.targetSignature === targetSignature) {
			return undefined;
		}

		const contents = await this.dependencies.reencodeImage(Buffer.from(await Bun.file(sourcePath).arrayBuffer()), JPEG_QUALITY);
		// Metadata mutations re-save constantly — skip the tmp+rename when the
		// exported bytes are already on disk, and remember the signatures so the
		// next save skips the re-encode too.
		const existing = targetStats
			? Buffer.from(
					await Bun.file(targetPath)
						.arrayBuffer()
						.catch(() => new ArrayBuffer(0)),
				)
			: Buffer.alloc(0);
		if (existing.length > 0 && existing.equals(contents)) {
			exportStamps.set(targetPath, { sourceSignature, targetSignature });

			return undefined;
		}

		await FileUtils.writeAtomic(targetPath, contents);

		const writtenStats = await FileUtils.getStats(targetPath);
		if (writtenStats) exportStamps.set(targetPath, { sourceSignature, targetSignature: fileStatSignature(writtenStats) });

		return targetPath;
	}
}

export const sidecarArtworkExporter = new SidecarArtworkExporter();
