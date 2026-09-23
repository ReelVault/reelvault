import { describe, expect, it } from "bun:test";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { serverConfig } from "@/server.config";
import { imageUploadService } from "./image-upload.service";

describe("ImageUploadService", () => {
	it("validates, optimizes and stores an uploaded image as WebP", async () => {
		const previousImagesPath = serverConfig.paths.images;
		const testRoot = join(tmpdir(), `reelvault-image-upload-${crypto.randomUUID()}`);
		serverConfig.paths.images = testRoot;

		try {
			const source = await sharp({
				create: {
					width: 640,
					height: 360,
					channels: 4,
					background: { r: 30, g: 60, b: 90, alpha: 1 },
				},
			})
				.png()
				.toBuffer();

			const result = await imageUploadService.upload(new File([source], "poster.png", { type: "image/png" }), {
				ownerType: "metadata",
				ownerId: "metadata-1",
				variant: "poster",
			});

			expect(result.contentType).toBe("image/webp");
			expect(result.width).toBe(240);
			expect(result.height).toBe(360);
			expect(result.fileSize).toBeGreaterThan(0);
			expect(result.localPath.startsWith(join(testRoot, ".tmp"))).toBe(true);
			expect((await stat(result.localPath)).isFile()).toBe(true);
		} finally {
			serverConfig.paths.images = previousImagesPath;
			await rm(testRoot, { recursive: true, force: true });
		}
	});

	it("rejects payloads whose magic bytes are not a supported raster image", () => {
		const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>', "utf8");

		expect(
			imageUploadService.upload(new File([svg], "poster.svg", { type: "image/svg+xml" }), {
				ownerType: "metadata",
				ownerId: "metadata-1",
				variant: "poster",
			}),
		).rejects.toThrow("not a supported raster image");

		expect(
			imageUploadService.upload(new File([Buffer.from("definitely not an image")], "fake.png", { type: "image/png" }), {
				ownerType: "metadata",
				ownerId: "metadata-1",
				variant: "poster",
			}),
		).rejects.toThrow("not a supported raster image");
	});
});
