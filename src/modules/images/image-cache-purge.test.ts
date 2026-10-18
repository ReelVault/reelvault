import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { DirUtils, removeTree } from "@/utils/directory.utils";

let testImagesDir: string;
let originalImagesPath: string;

beforeEach(async () => {
	originalImagesPath = serverConfig.paths.images;
	testImagesDir = await mkdtemp(join(tmpdir(), "reelvault-image-cache-purge-test-"));
	serverConfig.paths.images = testImagesDir;

	await DirUtils.create(join(testImagesDir, "posters"));
	await DirUtils.create(join(testImagesDir, ".cache"));
});

afterEach(async () => {
	serverConfig.paths.images = originalImagesPath;
	await removeTree(testImagesDir);
});

test("removes the optimized copies and keeps the originals", async () => {
	await Bun.write(join(testImagesDir, ".cache", "poster_300_0"), "x".repeat(10));
	await Bun.write(join(testImagesDir, ".cache", "poster_500_0.webp"), "y".repeat(25));
	await Bun.write(join(testImagesDir, "posters", "poster.webp"), "original");

	const result = await imageMaintenanceService.purgeOptimizedCache();

	expect(result).toEqual({ removedFiles: 2, freedBytes: 35 });
	expect(await Bun.file(join(testImagesDir, ".cache", "poster_300_0")).exists()).toBe(false);
	expect(await Bun.file(join(testImagesDir, "posters", "poster.webp")).exists()).toBe(true);
});

test("reports nothing removed when the cache is already empty", async () => {
	expect(await imageMaintenanceService.purgeOptimizedCache()).toEqual({ removedFiles: 0, freedBytes: 0 });
});
