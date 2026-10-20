import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { sourceVersionCache } from "@/modules/images/cache/source-version.cache";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { createDirectory, removeTree } from "@/utils/directory.utils";
import { fileExists, writeFile } from "@/utils/file.utils";
import { normalizePath } from "@/utils/path.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

describe("ImageMaintenanceService", () => {
	const db = useTestDatabase();
	let testImagesDir: string;
	let originalImagesPath: string;

	beforeEach(async () => {
		originalImagesPath = serverConfig.paths.images;
		testImagesDir = await mkdtemp(join(tmpdir(), "reelvault-image-maintenance-test-"));
		serverConfig.paths.images = testImagesDir;

		await createDirectory(join(testImagesDir, "posters"));
		await createDirectory(join(testImagesDir, ".tmp"));
		await createDirectory(join(testImagesDir, ".cache"));
	});

	afterEach(async () => {
		serverConfig.paths.images = originalImagesPath;
		await removeTree(testImagesDir);
	});

	test("purgeOrphanedImages deletes unreferenced image files and old tmp files", async () => {
		const validPath = join(testImagesDir, "posters", "valid.webp");
		const orphanPath = join(testImagesDir, "posters", "orphan.webp");
		const oldTmpPath = join(testImagesDir, ".tmp", "stale.tmp");

		await writeFile(validPath, new Uint8Array([1, 2, 3]));
		await writeFile(orphanPath, new Uint8Array([4, 5, 6]));
		await writeFile(oldTmpPath, new Uint8Array([7, 8, 9]));
		await db
			.client()
			.insert(schema.images)
			.values({
				id: "img-valid-1",
				stableKey: "stable-valid",
				localPath: normalizePath(validPath),
				contentType: "image/webp",
			});

		const result = await imageMaintenanceService.purgeOrphanedImages({ minAgeMs: 0 });

		expect(result.deletedCount).toBe(2);
		expect(await fileExists(validPath)).toBe(true);
		expect(await fileExists(orphanPath)).toBe(false);
		expect(await fileExists(oldTmpPath)).toBe(false);
	});

	test("reoptimizing a source in place invalidates its cached version stamp", async () => {
		const sourcePath = join(testImagesDir, "posters", "reoptimize.png");
		// Noise + compressionLevel 0 keeps the PNG far larger than the WebP the
		// service produces, so the in-place rewrite path actually runs.
		const noise = Buffer.alloc(256 * 256 * 3);
		for (let index = 0; index < noise.length; index++) noise[index] = Math.floor(Math.random() * 256);
		const png = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } })
			.png({ compressionLevel: 0 })
			.toBuffer();
		await writeFile(sourcePath, png);
		await db.client().insert(schema.images).values({
			id: "img-1",
			stableKey: "stable-reoptimize",
			localPath: sourcePath,
			contentType: "image/png",
			width: 256,
			height: 256,
		});

		const versionBefore = await sourceVersionCache.read(sourcePath);

		const outcome = await imageMaintenanceService.optimizeImageById("img-1");
		expect(outcome).toBe("reoptimized");

		expect(await sourceVersionCache.read(sourcePath)).not.toBe(versionBefore);
	});
});
