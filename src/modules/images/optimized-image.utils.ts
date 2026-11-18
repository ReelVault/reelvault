import type { OptimizedImageResult } from "@/integrations/sharp/sharp.actions";
import { createHash } from "@/utils/crypto.utils";

/**
 * Fields every path that turns sharp's optimized bytes into a storable image
 * produces. Shared so the upload and download/sidecar paths cannot drift on
 * the stored codec, dimensions or source-hash algorithm.
 */
export interface OptimizedImageFields {
	contentType: "image/webp";
	width: number;
	height: number;
	fileSize: number;
	sourceHash: string;
}

export function toOptimizedImageFields({ data, info }: OptimizedImageResult): OptimizedImageFields {
	return {
		contentType: "image/webp",
		width: info.width,
		height: info.height,
		fileSize: info.size,
		sourceHash: createHash("sha256").update(data).digest("hex"),
	};
}
