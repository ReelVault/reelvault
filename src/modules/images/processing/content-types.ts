import { ValidationError } from "@/utils/errors";

/**
 * Download/optimize allowlist keyed by the format libvips reported. Intentionally
 * broader than the upload magic-byte allowlist (`detectImageFormat`): libvips
 * decoded the bytes server-side, so svg/heif/tiff/bmp are safe here, while
 * client-controlled uploads must pass the raster-only signature check. Keep the
 * two sets separate.
 */
const contentTypes: Record<string, string> = {
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	heif: "image/heif",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	tiff: "image/tiff",
	webp: "image/webp",
};

export function getContentType(imageType: string): string {
	const contentType = contentTypes[imageType.toLowerCase()];
	if (!contentType) throw new ValidationError(`Unsupported image format: ${imageType}`);

	return contentType;
}
