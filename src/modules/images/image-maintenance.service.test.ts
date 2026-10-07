import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { imageRepository } from "@/database/repositories/images.repository";
import { sourceVersionCache } from "@/modules/images/cache/source-version.cache";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { serverConfig } from "@/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

describe("ImageMaintenanceService", () => {
	let testImagesDir: string;
	let originalImagesPath: string;

	beforeEach(async () => {
		originalImagesPath = serverConfig.paths.images;
		testImagesDir = await mkdtemp(join(tmpdir(), "reelvault-image-maintenance-test-"));
		serverConfig.paths.images = testImagesDir;

		await DirUtils.create(join(testImagesDir, "posters"));
		await DirUtils.create(join(testImagesDir, ".tmp"));
		await DirUtils.create(join(testImagesDir, ".cache"));
	});

	afterEach(async () => {
		serverConfig.paths.images = originalImagesPath;
		await rm(testImagesDir, { recursive: true, force: true });
	});

	test("purgeOrphanedImages deletes unreferenced image files and old tmp files", async () => {
		const validPath = PathUtils.join(testImagesDir, "posters", "valid.webp");
		const orphanPath = PathUtils.join(testImagesDir, "posters", "orphan.webp");
		const oldTmpPath = PathUtils.join(testImagesDir, ".tmp", "stale.tmp");

		await FileUtils.write(validPath, new Uint8Array([1, 2, 3]));
		await FileUtils.write(orphanPath, new Uint8Array([4, 5, 6]));
		await FileUtils.write(oldTmpPath, new Uint8Array([7, 8, 9]));

		const originalFindAll = imageRepository.findAllImageStorageIdentifiers;
		imageRepository.findAllImageStorageIdentifiers = async () => ({
			localPaths: new Set([PathUtils.normalize(validPath)]),
			imageIds: new Set(["img-valid-1"]),
		});

		try {
			const result = await imageMaintenanceService.purgeOrphanedImages({ minAgeMs: 0 });

			expect(result.deletedCount).toBe(2);
			expect(await FileUtils.exists(validPath)).toBe(true);
			expect(await FileUtils.exists(orphanPath)).toBe(false);
			expect(await FileUtils.exists(oldTmpPath)).toBe(false);
		} finally {
			imageRepository.findAllImageStorageIdentifiers = originalFindAll;
		}
	});

	test("reoptimizing a source in place invalidates its cached version stamp", async () => {
		const sourcePath = PathUtils.join(testImagesDir, "posters", "reoptimize.png");
		// Noise + compressionLevel 0 keeps the PNG far larger than the WebP the
		// service produces, so the in-place rewrite path actually runs.
		const noise = Buffer.alloc(256 * 256 * 3);
		for (let index = 0; index < noise.length; index++) noise[index] = Math.floor(Math.random() * 256);
		const png = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } })
			.png({ compressionLevel: 0 })
			.toBuffer();
		await FileUtils.write(sourcePath, png);

		const originalFindCandidate = imageRepository.findImageOptimizationCandidate;
		const originalMarkVersion = imageRepository.markImageOptimizationVersion;
		imageRepository.findImageOptimizationCandidate = async () => ({
			id: "img-1",
			localPath: sourcePath,
			width: 256,
			height: 256,
			fileSize: null,
		});
		imageRepository.markImageOptimizationVersion = async () => undefined;

		try {
			const versionBefore = await sourceVersionCache.read(sourcePath);

			const outcome = await imageMaintenanceService.optimizeImageById("img-1");
			expect(outcome).toBe("reoptimized");

			expect(await sourceVersionCache.read(sourcePath)).not.toBe(versionBefore);
		} finally {
			imageRepository.findImageOptimizationCandidate = originalFindCandidate;
			imageRepository.markImageOptimizationVersion = originalMarkVersion;
		}
	});
});
