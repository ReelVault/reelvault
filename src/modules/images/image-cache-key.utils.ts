import { createHash } from "@/utils/crypto.utils";

/** Prefix marking a cache entry generated from a source path with no registered image row. */
const SOURCE_ID_PREFIX = "src";

/** Builds the optimized-image cache filename shared by the writer and the orphan sweep. */
export function buildImageCacheKey(
	imageId: string | undefined,
	sourcePath: string,
	options: { width: number; height: number | null; quality: number },
	sourceVersion: string,
): string {
	const id = imageId ?? `${SOURCE_ID_PREFIX}_${createHash("sha1").update(sourcePath).digest("hex").slice(0, 16)}`;

	return `${id}_${options.width}_${options.height ?? 0}_${options.quality}_${sourceVersion}.webp`;
}

/** The registered image id encoded in a cache filename, or null for a source-derived entry. */
export function getRegisteredImageIdFromCacheKey(fileName: string): string | null {
	const id = fileName.split("_")[0];
	if (!id || id.startsWith(SOURCE_ID_PREFIX)) return null;

	return id;
}
