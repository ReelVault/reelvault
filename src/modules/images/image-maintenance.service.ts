import { imageRepository } from "@/database/repositories/images.repository";
import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { BatchGarbageCollector } from "@/utils/gc.utils";
import { PathUtils } from "@/utils/path.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";

export type ImageOptimizationOutcome = "reoptimized" | "kept" | "missing" | "skipped";

export interface PurgeOrphanedImagesResult {
	scannedCount: number;
	deletedCount: number;
	freedBytes: number;
}

interface ImageOptimizationCandidate {
	id: string;
	localPath: string;
	width: number | null;
	height: number | null;
}

class ImageMaintenanceService extends BaseService {
	private readonly gc = new BatchGarbageCollector();

	constructor() {
		super("ImageMaintenanceService");
	}

	async purgeOrphanedImages(options: { minAgeMs?: number } = {}, signal?: AbortSignal): Promise<PurgeOrphanedImagesResult> {
		return await this.safeExecute(
			"purgeOrphanedImages",
			async () => {
				throwIfAborted(signal);
				const minAgeMs = options.minAgeMs ?? 10 * MINUTE;
				const now = Date.now();

				const { localPaths, imageIds } = await imageRepository.findAllImageStorageIdentifiers();
				const imagesDir = serverConfig.paths.images;

				if (!(await DirUtils.exists(imagesDir))) {
					return { scannedCount: 0, deletedCount: 0, freedBytes: 0 };
				}

				// dot: true — the images root owns dot-dirs (.tmp/.cache) whose stale
				// files this sweep is responsible for.
				const scannedFiles = await DirUtils.scanFilesWithStats(imagesDir, ["webp", "jpeg", "jpg", "png", "tmp", "source"], 10, signal, {
					dot: true,
				});

				let deletedCount = 0;
				let freedBytes = 0;

				for (const entry of scannedFiles) {
					throwIfAborted(signal);
					if (this.shouldPurgeFile(entry.filePath, entry.mtimeMs, now, minAgeMs, localPaths, imageIds)) {
						if (await FileUtils.delete(entry.filePath)) {
							deletedCount++;
							freedBytes += entry.size;
						}
					}
				}

				return {
					scannedCount: scannedFiles.length,
					deletedCount,
					freedBytes,
				};
			},
			{ errorMessage: "Failed to purge orphaned image files" },
		);
	}

	private shouldPurgeFile(
		filePath: string,
		mtimeMs: number,
		now: number,
		minAgeMs: number,
		localPaths: Set<string>,
		imageIds: Set<string>,
	): boolean {
		const normalizedPath = PathUtils.normalize(filePath);
		const ageMs = now - mtimeMs;

		if (normalizedPath.includes("/.tmp/") || normalizedPath.endsWith(".tmp")) {
			return ageMs >= minAgeMs;
		}

		if (normalizedPath.includes("/.cache/")) {
			const fileName = PathUtils.getFileName(filePath);
			const imageIdPrefix = fileName.split("_")[0];

			// Fresh cache entries may belong to an image registered a moment later —
			// age-gate them like everything else instead of trusting the DB snapshot.
			return Boolean(imageIdPrefix && !imageIdPrefix.startsWith("src") && !imageIds.has(imageIdPrefix)) && ageMs >= minAgeMs;
		}

		return !localPaths.has(normalizedPath) && ageMs >= minAgeMs;
	}

	async findOutdatedImageIds(signal?: AbortSignal): Promise<string[]> {
		return await this.safeExecute(
			"findOutdatedImageIds",
			async () => {
				throwIfAborted(signal);

				return await imageRepository.findOutdatedImageIds(serverConfig.images.currentOptimizationVersion);
			},
			{ errorMessage: "cannot list outdated images" },
		);
	}

	async optimizeImageById(imageId: string, signal?: AbortSignal): Promise<ImageOptimizationOutcome> {
		return await this.safeExecute(
			"optimizeImageById",
			async () => {
				throwIfAborted(signal);
				const currentVersion = serverConfig.images.currentOptimizationVersion;
				const image = await imageRepository.findImageOptimizationCandidate(imageId, currentVersion);
				if (!image) return "skipped" as const;

				const outcome = await this.reoptimizeImage(image, currentVersion, signal);
				this.gc.tick();

				return outcome;
			},
			{ logContext: { imageId } },
		);
	}

	private async reoptimizeImage(
		image: ImageOptimizationCandidate,
		currentVersion: number,
		signal?: AbortSignal,
	): Promise<"kept" | "missing" | "reoptimized"> {
		const stats = await FileUtils.getStats(image.localPath);
		if (!stats) {
			await imageRepository.markImageOptimizationVersion(image.id, currentVersion);

			return "missing";
		}

		const variant = resolveOptimizationVariant(image.width, image.height);
		const { data, info } = await optimizeImageWithInfo(image.localPath, variant, signal);

		if (info.size >= stats.size) {
			await imageRepository.markImageOptimizationVersion(image.id, currentVersion);

			return "kept";
		}

		try {
			await FileUtils.writeAtomic(image.localPath, data);
		} catch {
			throw new InternalError(`Cannot write optimized image: ${image.localPath}`, { code: "image.write_failed" });
		}

		await imageRepository.markImageOptimizationVersion(image.id, currentVersion, {
			width: info.width,
			height: info.height,
			fileSize: info.size,
		});

		return "reoptimized";
	}
}

function resolveOptimizationVariant(width: number | null, height: number | null): SharpImageOptions {
	const variants = serverConfig.images.variants;
	const aspect = width && height ? width / height : 0;
	if (aspect === 0 || (aspect >= 0.95 && aspect <= 1.05)) {
		return {
			width: variants.backdrop.width,
			height: null,
			quality: variants.backdrop.quality,
			// no effort — resolved at encode time from measured CPU capacity
			fit: "inside",
			withoutEnlargement: true,
		};
	}

	return aspect > 1 ? variants.backdrop : variants.poster;
}

export const imageMaintenanceService = new ImageMaintenanceService();
