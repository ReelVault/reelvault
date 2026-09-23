import { ValidationError } from "@/utils/errors";

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
