import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import sharp from "sharp";
import { imageOptimizationService } from "./image-optimization.service";

describe("ImageOptimizationService", () => {
	it("caps API dimensions at 1920 pixels", async () => {
		const sourcePath = join(tmpdir(), `reelvault-image-optimization-${crypto.randomUUID()}.png`);

		const engine = sharp({
			create: {
				width: 3840,
				height: 2160,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		});
		const source = await engine.png().toBuffer();

		await write(sourcePath, source);
		try {
			const result = await imageOptimizationService.getOptimizedImage(sourcePath, {
				width: 3840,
				height: 3840,
				quality: 85,
			});
			const metadata = await sharp(await result.file.arrayBuffer()).metadata();

			expect(result.options.width).toBe(1920);
			expect(result.options.height).toBe(1920);
			expect(metadata.width).toBe(1920);
			expect(metadata.height).toBe(1080);
		} finally {
			await rm(sourcePath, { force: true });
		}
	});

	it("does not run sharp optimization when the request is already aborted", async () => {
		const sourcePath = join(tmpdir(), `reelvault-image-optimization-${crypto.randomUUID()}.png`);

		const engine = sharp({
			create: { width: 320, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
		});
		const source = await engine.png().toBuffer();

		await write(sourcePath, source);
		try {
			const controller = new AbortController();
			controller.abort();
			expect(imageOptimizationService.getOptimizedImage(sourcePath, { width: 160 }, undefined, controller.signal)).rejects.toThrow();
		} finally {
			await rm(sourcePath, { force: true });
		}
	});
});
