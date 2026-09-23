import { describe, expect, test } from "bun:test";
import { NotFoundError } from "@/utils/errors";
import type { OptimizedImage } from "./image-optimization.service";
import { ImagesService } from "./images.service";

const OPTIMIZED_RESULT: OptimizedImage = {
	file: new Blob([new Uint8Array([9])]),
	contentType: "image/webp",
	options: { width: 640, height: null, quality: 75 },
};

interface ServiceConfig {
	row?: { localPath: string; contentType: string } | undefined;
	fileExists?: boolean | undefined;
	deletedRow?: { localPath: string } | undefined;
}

function createService(config: ServiceConfig = {}) {
	const spies = {
		optimizedRequests: [] as Array<{ sourcePath: string; imageId: string | undefined }>,
		deletedFiles: [] as string[],
		optimizedResult: OPTIMIZED_RESULT,
	};
	const service = new ImagesService({
		findForFileRead: async () => config.row,
		deleteAndReturn: async () => config.deletedRow,
		fileExists: async () => config.fileExists ?? true,
		deleteFile: (path) => {
			spies.deletedFiles.push(path);

			return Promise.resolve(true);
		},
		getOptimizedImage: (sourcePath, _request, imageId) => {
			spies.optimizedRequests.push({ sourcePath, imageId });

			return Promise.resolve(spies.optimizedResult);
		},
	});

	return { service, spies };
}

describe("ImagesService", () => {
	test("getById returns the file handle with the stored content type", async () => {
		const { service } = createService({ row: { localPath: "/images/posters/a.webp", contentType: "image/webp" } });

		const result = await service.getById("image-1");

		expect(result.localPath).toBe("/images/posters/a.webp");
		expect(result.contentType).toBe("image/webp");
		expect(result.file.name).toBe("/images/posters/a.webp");
	});

	test("getById throws NotFoundError when the row is missing", async () => {
		const { service } = createService();

		await expect(service.getById("missing")).rejects.toThrow(NotFoundError);
	});

	test("getById throws NotFoundError when the file is gone from disk", async () => {
		const { service } = createService({ row: { localPath: "/images/posters/gone.webp", contentType: "image/webp" }, fileExists: false });

		await expect(service.getById("image-1")).rejects.toThrow("Image file not found: image-1");
	});

	test("getOptimizedById passes the original file through when the query is empty", async () => {
		const { service, spies } = createService({ row: { localPath: "/images/posters/a.webp", contentType: "image/webp" } });

		const result = await service.getOptimizedById("image-1", {});

		expect(result.options).toBeNull();
		expect(result.contentType).toBe("image/webp");
		expect(spies.optimizedRequests).toEqual([]);
	});

	test("getOptimizedById delegates to the optimization service when dimensions are requested", async () => {
		const { service, spies } = createService({ row: { localPath: "/images/posters/a.webp", contentType: "image/webp" } });

		const result = await service.getOptimizedById("image-1", { width: 640 });

		expect(result.options).toEqual({ width: 640, height: null, quality: 75 });
		expect(spies.optimizedRequests).toEqual([{ sourcePath: "/images/posters/a.webp", imageId: "image-1" }]);
	});

	test("delete removes the file of the deleted row", async () => {
		const { service, spies } = createService({ deletedRow: { localPath: "/images/posters/dead.webp" } });

		const result = await service.delete("image-1");

		expect(result).toEqual({ success: true });
		expect(spies.deletedFiles).toEqual(["/images/posters/dead.webp"]);
	});

	test("delete throws NotFoundError when the row is missing and keeps files untouched", async () => {
		const { service, spies } = createService();

		await expect(service.delete("missing")).rejects.toThrow(NotFoundError);
		expect(spies.deletedFiles).toEqual([]);
	});
});
