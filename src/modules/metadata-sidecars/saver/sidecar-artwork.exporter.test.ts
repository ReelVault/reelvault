import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { imageRepository } from "@/database/repositories/images.repository";
import { SidecarArtworkExporter } from "./sidecar-artwork.exporter";

/** Replaces a method on the live singleton for one test.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod(target: object, method: string, impl: (...args: unknown[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method);
	Reflect.set(target, method, (...args: unknown[]) => impl(...args));

	return {
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

const storeImage = { localPath: "/store/images/posters/stored.webp", contentType: "image/webp" };

async function writeStoreImage(directory: string): Promise<string> {
	const sourcePath = join(directory, "stored.webp");
	await Bun.write(
		sourcePath,
		await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } })
			.webp()
			.toBuffer(),
	);

	return sourcePath;
}

describe("SidecarArtworkExporter", () => {
	test("exports poster.jpg and fanart.jpg next to a title as jpeg", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			const sourcePath = await writeStoreImage(directory);
			activeStubs.push(stubMethod(imageRepository, "findMetadataImagePath", () => Promise.resolve(sourcePath)));

			const written = await new SidecarArtworkExporter().saveTitleArtwork({ metadataId: "metadata-1", directory });

			expect(written).toEqual([join(directory, "poster.jpg"), join(directory, "fanart.jpg")]);
			for (const file of written) {
				const metadata = await sharp(await readFile(file)).metadata();
				expect(metadata.format).toBe("jpeg");
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("exports the season poster and episode thumbnail by their conventional names", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			const sourcePath = await writeStoreImage(directory);
			activeStubs.push(stubMethod(imageRepository, "findForFileRead", () => Promise.resolve({ ...storeImage, localPath: sourcePath })));

			const exporter = new SidecarArtworkExporter();
			const season = await exporter.saveSeasonArtwork({ imageId: "image-1", directory, seasonNumber: 2 });
			const episode = await exporter.saveEpisodeArtwork({ imageId: "image-1", directory, videoBaseName: "S01E01" });

			expect(season).toEqual([join(directory, "season02-poster.jpg")]);
			expect(episode).toEqual([join(directory, "S01E01-thumb.jpg")]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("skips the rewrite when the exported bytes are already on disk", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			const sourcePath = await writeStoreImage(directory);
			activeStubs.push(stubMethod(imageRepository, "findMetadataImagePath", () => Promise.resolve(sourcePath)));

			const exporter = new SidecarArtworkExporter();
			await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory });
			const second = await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory });

			expect(second).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("skips exports without a persisted image", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			activeStubs.push(
				stubMethod(imageRepository, "findMetadataImagePath", () => Promise.resolve(undefined)),
				stubMethod(imageRepository, "findForFileRead", () => Promise.resolve(undefined)),
			);

			const exporter = new SidecarArtworkExporter();
			const title = await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory });
			const episode = await exporter.saveEpisodeArtwork({ imageId: "image-404", directory, videoBaseName: "S01E01" });
			const noImageId = await exporter.saveSeasonArtwork({ imageId: null, directory, seasonNumber: 1 });

			expect(title).toEqual([]);
			expect(episode).toEqual([]);
			expect(noImageId).toEqual([]);
			expect(await readdir(directory)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
