import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageRepository } from "@/database/repositories/images.repository";
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
});
