import type { ImageQuery } from "@sdk/common/images";
import { file as bunFile } from "bun";
import { optimizeImage } from "@/integrations/sharp/sharp.actions";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { createHash } from "@/utils/crypto.utils";
import { DirUtils } from "@/utils/directory.utils";
import { errorMessage } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { imageCacheEviction } from "./cache/image-cache.eviction";
import { parseImageRequest } from "./cache/image-request.parser";
import { InflightDedup } from "./cache/inflight.dedup";
import { sourceVersionCache } from "./cache/source-version.cache";

const CONTENT_TYPE = "image/webp";

export interface OptimizedImage {
	file: ReturnType<typeof bunFile> | Blob;
	contentType: typeof CONTENT_TYPE;
	options: SharpImageOptions;
}

class ImageOptimizationService extends BaseService {
	private readonly inflight = new InflightDedup<OptimizedImage>();

	constructor() {
		super("ImageOptimizationService");
	}

	async getOptimizedImage(sourcePath: string, request: ImageQuery, imageId?: string, signal?: AbortSignal): Promise<OptimizedImage> {
		const options = parseImageRequest(request, serverConfig.images);
		const cacheDir = PathUtils.join(serverConfig.paths.images, ".cache");
		const sourceVersion = await sourceVersionCache.read(sourcePath);
		const cacheKey = `${imageId ?? `src_${createHash("sha1").update(sourcePath).digest("hex").slice(0, 16)}`}_${options.width}_${options.height ?? 0}_${options.quality}_${sourceVersion}.webp`;
		const cachePath = PathUtils.join(cacheDir, cacheKey);

		const cachedFile = bunFile(cachePath);
		if (await cachedFile.exists()) {
			return { file: cachedFile, contentType: CONTENT_TYPE, options };
		}

		return await this.inflight.run(cachePath, () => this.optimizeAndCache(cacheDir, cachePath, sourcePath, options, signal));
	}

	private async optimizeAndCache(
		cacheDir: string,
		cachePath: string,
		sourcePath: string,
		options: SharpImageOptions,
		signal?: AbortSignal,
	): Promise<OptimizedImage> {
		// Abandoned requests (client disconnect) must not consume sharp capacity.
		throwIfAborted(signal);
		const optimized = await optimizeImage(sourcePath, options, signal);
		try {
			await DirUtils.create(cacheDir);
			await FileUtils.writeAtomic(cachePath, optimized);
			// Fire-and-forget must not become an unhandled rejection on fs errors.
			detach(
				(async () => {
					try {
						await imageCacheEviction.evictIfDue(cacheDir);
					} catch {
						// Cache eviction is best-effort.
					}
				})(),
			);

			return { file: bunFile(cachePath), contentType: CONTENT_TYPE, options };
		} catch (error) {
			// Serving from memory keeps the image working, but a persistent cache
			// write failure means every request re-runs the optimizer — say so.
			this.logger.warn("Image cache write failed — serving optimized bytes from memory", { cachePath, error: errorMessage(error) });
			const blobData = new ArrayBuffer(optimized.byteLength);
			new Uint8Array(blobData).set(optimized);

			return {
				file: new Blob([blobData], { type: CONTENT_TYPE }),
				contentType: CONTENT_TYPE,
				options,
			};
		}
	}
}

export const imageOptimizationService = new ImageOptimizationService();
