import { IMAGE_SUPPORTED_HEIGHTS, IMAGE_SUPPORTED_QUALITIES, IMAGE_SUPPORTED_WIDTHS, type ImageQuery } from "@reelvault/sdk/common";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";

interface ImagesConfig {
	maxWidth: number;
	maxHeight: number;
	optimization: { defaultWidth: number; defaultQuality: number };
}

export function parseImageRequest(request: ImageQuery, imagesConfig: ImagesConfig): SharpImageOptions {
	const width = nearestValue(
		IMAGE_SUPPORTED_WIDTHS,
		Math.min(request.width ?? imagesConfig.optimization.defaultWidth, imagesConfig.maxWidth),
	);
	const height = request.height ? nearestValue(IMAGE_SUPPORTED_HEIGHTS, Math.min(request.height, imagesConfig.maxHeight)) : null;
	const quality = nearestValue(IMAGE_SUPPORTED_QUALITIES, request.quality ?? imagesConfig.optimization.defaultQuality);

	return { width, height, quality };
}

function nearestValue<T extends number>(values: readonly T[], value: number): T {
	return values.reduce((closest, current) => (Math.abs(current - value) < Math.abs(closest - value) ? current : closest));
}
