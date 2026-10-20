import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createDirectory, removeTree } from "@/utils/directory.utils";
import { fileExists, writeFile } from "@/utils/file.utils";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { ImagesService } from "./images.service";

describe("ImagesService", () => {
	const db = useTestDatabase();
	const service = new ImagesService();
	let testImagesDir: string;
	let originalImagesPath: string;

	beforeEach(async () => {
		originalImagesPath = serverConfig.paths.images;
		testImagesDir = await mkdtemp(join(tmpdir(), "reelvault-images-service-test-"));
		serverConfig.paths.images = testImagesDir;

		await createDirectory(join(testImagesDir, "posters"));
	});

	afterEach(async () => {
		serverConfig.paths.images = originalImagesPath;
		await removeTree(testImagesDir);
	});

	// Each test uses its own image id: the repository caches file reads by id for the whole process.
	async function seedImage(id: string, localPath: string, contentType: string): Promise<void> {
		await db
			.client()
			.insert(schema.images)
			.values({ id, stableKey: `stable-${id}`, localPath, contentType });
	}

	test("getById returns the file handle with the stored content type", async () => {
		const localPath = join(testImagesDir, "posters", "a.webp");
		await writeFile(localPath, new Uint8Array([1, 2, 3]));
		await seedImage("image-handle", localPath, "image/webp");

		const result = await service.getById("image-handle");

		expect(result.localPath).toBe(localPath);
		expect(result.contentType).toBe("image/webp");
		expect(result.file.name).toBe(localPath);
	});

	test("getById throws NotFoundError when the row is missing", async () => {
		await expect(service.getById("missing")).rejects.toMatchObject({ category: "not_found" });
	});

	test("getById throws NotFoundError when the file is gone from disk", async () => {
		await seedImage("image-gone", join(testImagesDir, "posters", "gone.webp"), "image/webp");

		await expect(service.getById("image-gone")).rejects.toMatchObject({ category: "not_found", code: "images.not_found" });
	});

	test("getOptimizedById passes the original file through when the query is empty", async () => {
		const localPath = join(testImagesDir, "posters", "a.webp");
		await writeFile(localPath, new Uint8Array([1, 2, 3]));
		await seedImage("image-passthrough", localPath, "image/webp");

		const result = await service.getOptimizedById("image-passthrough", {});

		expect(result.options).toBeNull();
		expect(result.contentType).toBe("image/webp");
		expect(new Uint8Array(await result.file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("getOptimizedById returns a scaled WebP when dimensions are requested", async () => {
		const localPath = join(testImagesDir, "posters", "wide.png");
		await writeFile(
			localPath,
			await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#305a5a" } })
				.png()
				.toBuffer(),
		);
		await seedImage("image-scaled", localPath, "image/png");

		const result = await service.getOptimizedById("image-scaled", { width: 640 });

		expect(result.options).toMatchObject({ width: 640 });
		expect(result.contentType).toBe("image/webp");
		expect((await sharp(await result.file.arrayBuffer()).metadata()).width).toBe(640);
	});

	test("delete removes the row and the file it pointed to", async () => {
		const localPath = join(testImagesDir, "posters", "dead.webp");
		await writeFile(localPath, new Uint8Array([1, 2, 3]));
		await seedImage("image-deleted", localPath, "image/webp");

		expect(await service.delete("image-deleted")).toEqual({ success: true });

		expect(await fileExists(localPath)).toBe(false);
		await expect(service.getById("image-deleted")).rejects.toMatchObject({ category: "not_found" });
	});

	test("delete throws NotFoundError when the row is missing and keeps files untouched", async () => {
		const unrelated = join(testImagesDir, "posters", "keep.webp");
		await writeFile(unrelated, new Uint8Array([1, 2, 3]));

		await expect(service.delete("missing")).rejects.toMatchObject({ category: "not_found" });
		expect(await fileExists(unrelated)).toBe(true);
	});
});
