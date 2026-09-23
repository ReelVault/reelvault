import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { optimizeImage, reencodeImage } from "@/integrations/sharp/sharp.actions";
import type { SharpImageOptions } from "@/integrations/sharp/sharp.types";
import { serverConfig } from "@/server.config";

const options: SharpImageOptions = {
	width: 128,
	height: null,
	quality: 60,
};

describe("Sharp image optimization", () => {
	it("resizes and converts a source image to the requested format", async () => {
		const source = await sharp({
			create: {
				width: 640,
				height: 360,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		const optimized = await optimizeImage(source, options);
		const metadata = await sharp(optimized).metadata();

		expect(metadata.format).toBe("webp");
		expect(metadata.width).toBe(128);
		expect(metadata.height).toBe(72);
	});

	it("crops a poster to 2:3 without enlarging a smaller source", async () => {
		const source = await sharp({
			create: {
				width: 640,
				height: 360,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		const optimized = await optimizeImage(source, serverConfig.images.variants.poster);
		const metadata = await sharp(optimized).metadata();

		expect(metadata.width).toBe(240);
		expect(metadata.height).toBe(360);
	});

	it("caps a large poster at 1000x1500", async () => {
		const source = await sharp({
			create: {
				width: 1600,
				height: 2400,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		const optimized = await optimizeImage(source, serverConfig.images.variants.poster);
		const metadata = await sharp(optimized).metadata();

		expect(metadata.width).toBe(1000);
		expect(metadata.height).toBe(1500);
	});

	it("limits a backdrop to 1920x1080", async () => {
		const source = await sharp({
			create: {
				width: 3840,
				height: 2160,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		})
			.png()
			.toBuffer();

		const optimized = await optimizeImage(source, serverConfig.images.variants.backdrop);
		const metadata = await sharp(optimized).metadata();

		expect(metadata.width).toBe(1920);
		expect(metadata.height).toBe(1080);
	});

	it("re-encodes a store variant to jpeg without resizing", async () => {
		const source = await sharp({
			create: {
				width: 640,
				height: 360,
				channels: 4,
				background: { r: 24, g: 48, b: 72, alpha: 1 },
			},
		})
			.webp()
			.toBuffer();

		const jpeg = await reencodeImage(source, 85);
		const metadata = await sharp(jpeg).metadata();

		expect(metadata.format).toBe("jpeg");
		expect(metadata.width).toBe(640);
		expect(metadata.height).toBe(360);
	});
});
