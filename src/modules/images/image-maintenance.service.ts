import { readdir } from "node:fs/promises";
import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { optimizeImageWithInfo } from "@/integrations/sharp/sharp.actions";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";
import { imageCacheEviction } from "@/modules/images/cache/image-cache.eviction";
import { sourceVersionCache } from "@/modules/images/cache/source-version.cache";
import { type ImageOptimizationCandidate, imagesStorage } from "@/modules/images/images.ports";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { directoryExists, scanFilesWithStats } from "@/utils/directory.utils";
import { DomainError } from "@/utils/domain.errors";
import { deleteFile, getFileStats, writeFileAtomic } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { BatchGarbageCollector } from "@/utils/mem.utils";
import { getFileName, joinPath, normalizePath } from "@/utils/path.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";

export type ImageOptimizationOutcome = "reoptimized" | "kept" | "missing" | "skipped";

export interface PurgeOrphanedImagesResult {
	scannedCount: number;
	deletedCount: number;
	freedBytes: number;
}

export interface PurgeOptimizedCacheResult {
	removedFiles: number;
	freedBytes: number;
}

class ImageMaintenanceService {
	readonly serviceName = "ImageMaintenanceService";
	readonly logger = createLogger("ImageMaintenanceService");

	private readonly gc = new BatchGarbageCollector();

	/**
	 * Deletes the optimized copies under `images/.cache`. Originals stay, and a copy requested again is rebuilt from its
	 * original, so a purge only costs the next requests a rebuild.
	 */
	async purgeOptimizedCache(): Promise<PurgeOptimizedCacheResult> {
		return await runSafely(this, "purgeOptimizedCache", async () => {
			const cacheDir = joinPath(serverConfig.paths.images, ".cache");
			let names: string[] = [];
			if (await directoryExists(cacheDir)) {
				names = await readdir(cacheDir);
			}
			const ioConcurrency = systemResourcesService.getIoConcurrency();
			const files = (
				await mapConcurrent(names, ioConcurrency, async (name) => {
					const path = joinPath(cacheDir, name);
					const stats = await getFileStats(path);

					return stats?.isFile() ? { path, size: stats.size } : null;
				})
			).filter((file): file is { path: string; size: number } => file !== null);

			const removedSizes = await mapConcurrent(files, ioConcurrency, async (file) => ((await deleteFile(file.path)) ? file.size : null));
			const removed = removedSizes.filter((size): size is number => size !== null);

			imageCacheEviction.forget(cacheDir);

			return { removedFiles: removed.length, freedBytes: removed.reduce((sum, size) => sum + size, 0) };
		});
	}

	async purgeOrphanedImages(options: { minAgeMs?: number } = {}, signal?: AbortSignal): Promise<PurgeOrphanedImagesResult> {
		return await runSafely(
			this,
			"purgeOrphanedImages",
			async () => {
				throwIfAborted(signal);
				const minAgeMs = options.minAgeMs ?? 10 * MINUTE;
				const now = Date.now();

				const { localPaths, imageIds } = await imagesStorage().findAllImageStorageIdentifiers();
				const imagesDir = serverConfig.paths.images;

				if (!(await directoryExists(imagesDir))) {
					return { scannedCount: 0, deletedCount: 0, freedBytes: 0 };
				}

				// dot: true — the images root owns dot-dirs (.tmp/.cache) whose stale
				// files this sweep is responsible for.
				const scannedFiles = await scanFilesWithStats(imagesDir, ["webp", "jpeg", "jpg", "png", "tmp", "source"], 10, signal, {
					dot: true,
				});

				let deletedCount = 0;
				let freedBytes = 0;

				for (const entry of scannedFiles) {
					throwIfAborted(signal);
					if (
						this.shouldPurgeFile(entry.filePath, entry.mtimeMs, { now, minAgeMs, localPaths, imageIds }) &&
						(await deleteFile(entry.filePath))
					) {
						deletedCount++;
						freedBytes += entry.size;
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
		scope: { now: number; minAgeMs: number; localPaths: Set<string>; imageIds: Set<string> },
	): boolean {
		const { now, minAgeMs, localPaths, imageIds } = scope;
		const normalizedPath = normalizePath(filePath);
		const ageMs = now - mtimeMs;

		if (normalizedPath.includes("/.tmp/") || normalizedPath.endsWith(".tmp")) {
			return ageMs >= minAgeMs;
		}

		if (normalizedPath.includes("/.cache/")) {
			const fileName = getFileName(filePath);
			const imageIdPrefix = fileName.split("_")[0];

			// Fresh cache entries may belong to an image registered a moment later —
			// age-gate them like everything else instead of trusting the DB snapshot.
			return Boolean(imageIdPrefix && !imageIdPrefix.startsWith("src") && !imageIds.has(imageIdPrefix)) && ageMs >= minAgeMs;
		}

		return !localPaths.has(normalizedPath) && ageMs >= minAgeMs;
	}

	async findOutdatedImageIds(signal?: AbortSignal): Promise<string[]> {
		return await runSafely(
			this,
			"findOutdatedImageIds",
			async () => {
				throwIfAborted(signal);

				return await imagesStorage().findOutdatedImageIds(serverConfig.images.currentOptimizationVersion);
			},
			{ errorMessage: "cannot list outdated images" },
		);
	}

	async optimizeImageById(imageId: string, signal?: AbortSignal): Promise<ImageOptimizationOutcome> {
		return await runSafely(
			this,
			"optimizeImageById",
			async () => {
				throwIfAborted(signal);
				const currentVersion = serverConfig.images.currentOptimizationVersion;
				const image = await imagesStorage().findImageOptimizationCandidate(imageId, currentVersion);
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
		const stats = await getFileStats(image.localPath);
		if (!stats) {
			await imagesStorage().markImageOptimizationVersion(image.id, currentVersion);

			return "missing";
		}

		const variant = resolveOptimizationVariant(image.width, image.height);
		const { data, info } = await optimizeImageWithInfo(image.localPath, variant, signal);

		if (info.size >= stats.size) {
			await imagesStorage().markImageOptimizationVersion(image.id, currentVersion);

			return "kept";
		}

		try {
			await writeFileAtomic(image.localPath, data);
			// The source changed in place under the same path — drop its version
			// stamp or the optimized-variant cache keeps serving pre-optimization bytes.
			sourceVersionCache.invalidate(image.localPath);
		} catch {
			throw new DomainError("internal", `Cannot write optimized image: ${image.localPath}`, { code: "image.write_failed" });
		}

		await imagesStorage().markImageOptimizationVersion(image.id, currentVersion, {
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
