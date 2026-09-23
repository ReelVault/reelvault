import type { ImageQuality } from "@reelvault/sdk/common";
import { imageRepository } from "@/database/repositories/images.repository";
import { reencodeImage } from "@/integrations/sharp/sharp.actions";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { assertEpisodeBaseName, formatSeasonNumber } from "./sidecar-path.policy";

const JPEG_QUALITY: ImageQuality = 85;

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
	constructor() {
		super("SidecarArtworkExporter");
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
		const contents = await reencodeImage(Buffer.from(await Bun.file(sourcePath).arrayBuffer()), JPEG_QUALITY);
		// Metadata mutations re-save constantly — skip the tmp+rename when the
		// exported bytes are already on disk.
		const existing = Buffer.from(
			await Bun.file(targetPath)
				.arrayBuffer()
				.catch(() => new ArrayBuffer(0)),
		);
		if (existing.length > 0 && existing.equals(contents)) return undefined;

		await FileUtils.writeAtomic(targetPath, contents);

		return targetPath;
	}
}

export const sidecarArtworkExporter = new SidecarArtworkExporter();
