import type { ImageQuality } from "@sdk/common/images";
import sharp, { type Sharp } from "sharp";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { PromiseUtils } from "@/utils/promise.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import type { SharpImageOptions } from "./sharp.types";

let sharpInitialized = false;

function ensureSharpConfig(): void {
	if (sharpInitialized) return;

	sharpInitialized = true;

	// Disable libvips operation/file cache to prevent memory ballooning during batch processing
	sharp.cache(false);
	// Limit internal libvips worker threads to 1 per operation to prevent glibc malloc arena fragmentation
	sharp.concurrency(1);
	sharp.simd(true);
}

const sharpSemaphore = PromiseUtils.createSemaphore(() => systemResourcesService.getSharpConcurrency());

interface Dimensions {
	width: number;
	height: number;
}

export function getImageMetadata(filePath: string) {
	ensureSharpConfig();

	return sharp(filePath, { limitInputPixels: serverConfig.sharp.maxInputPixels, failOn: "error" }).metadata();
}

async function getCoverDimensions(input: Sharp, targetWidth: number, targetHeight: number): Promise<Dimensions> {
	const metadata = await input.metadata();

	const sourceWidth = metadata.autoOrient.width;
	const sourceHeight = metadata.autoOrient.height;
	if (!(sourceWidth && sourceHeight)) {
		// Degenerate metadata — fall back to the requested rect instead of
		// producing NaN geometry that 500s an otherwise fine image.
		return { width: targetWidth, height: targetHeight };
	}

	const targetRatio = targetWidth / targetHeight;
	const sourceRatio = sourceWidth / sourceHeight;

	const cropWidth = sourceRatio > targetRatio ? Math.floor(sourceHeight * targetRatio) : sourceWidth;
	const cropHeight = sourceRatio > targetRatio ? sourceHeight : Math.floor(sourceWidth / targetRatio);
	const scale = Math.min(1, targetWidth / cropWidth, targetHeight / cropHeight);

	return {
		width: Math.max(1, Math.floor(cropWidth * scale)),
		height: Math.max(1, Math.floor(cropHeight * scale)),
	};
}

export interface OptimizedImageResult {
	data: Buffer;
	info: {
		format: string;
		width: number;
		height: number;
		size: number;
	};
}

export async function optimizeImageWithInfo(
	input: Buffer | string,
	options: SharpImageOptions,
	signal?: AbortSignal,
): Promise<OptimizedImageResult> {
	throwIfAborted(signal);
	ensureSharpConfig();
	await sharpSemaphore.acquire(signal);
	try {
		throwIfAborted(signal);
		const sharpInput = sharp(input, { limitInputPixels: serverConfig.sharp.maxInputPixels, failOn: "error" });
		const { fit = "inside", withoutEnlargement = true } = options;

		let dimensions: Dimensions | null = null;
		if (fit === "cover" && options.height !== null && withoutEnlargement) {
			dimensions = await getCoverDimensions(sharpInput, options.width, options.height);
		}

		let pipeline = sharpInput.rotate();
		pipeline = pipeline.resize({
			width: dimensions?.width ?? options.width,
			height: dimensions?.height ?? options.height ?? undefined,
			fit,
			position: options.position,
			withoutEnlargement,
		});

		throwIfAborted(signal);
		const { data, info } = await pipeline
			// Effort resolves from measured CPU capacity — slow cores trade a
			// slightly larger file for far less encode time on this inline path.
			.webp({ quality: options.quality, effort: options.effort ?? systemResourcesService.getImageEffort() })
			.toBuffer({ resolveWithObject: true });

		return {
			data,
			info: {
				format: info.format,
				width: info.width,
				height: info.height,
				size: info.size,
			},
		};
	} finally {
		sharpSemaphore.release();
	}
}

export async function optimizeImage(input: Buffer | string, options: SharpImageOptions, signal?: AbortSignal): Promise<Buffer> {
	const result = await optimizeImageWithInfo(input, options, signal);

	return result.data;
}

/** Container conversion of an already-sized image (webp store variant → jpeg
 * for sidecar artwork export). No resize — only the codec changes. */
export async function reencodeImage(input: Buffer | string, quality: ImageQuality, signal?: AbortSignal): Promise<Buffer> {
	throwIfAborted(signal);
	ensureSharpConfig();
	await sharpSemaphore.acquire(signal);
	try {
		throwIfAborted(signal);

		return await sharp(input, { limitInputPixels: serverConfig.sharp.maxInputPixels, failOn: "error" })
			.rotate()
			.jpeg({ quality })
			.toBuffer();
	} finally {
		sharpSemaphore.release();
	}
}
