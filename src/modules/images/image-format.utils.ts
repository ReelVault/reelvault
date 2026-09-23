/**
 * Magic-byte allowlist for user uploads. The declared `Content-Type` is
 * client-controlled, and sharp happily rasterizes SVG sources — uploads must
 * be plain raster images we can name by their leading bytes alone.
 */
const IMAGE_MAGIC: Array<{ format: string; test: (bytes: Buffer) => boolean }> = [
	{ format: "jpeg", test: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
	{
		format: "png",
		test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
	},
	{ format: "webp", test: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
	{ format: "gif", test: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
	{ format: "avif", test: (b) => b.subarray(4, 8).toString("ascii") === "ftyp" && b.subarray(8, 12).toString("ascii").startsWith("avif") },
];

export function detectImageFormat(bytes: Buffer): string | undefined {
	return IMAGE_MAGIC.find((signature) => signature.test(bytes))?.format;
}
