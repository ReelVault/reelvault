import { describe, expect, test } from "bun:test";
import { createHash } from "@/utils/crypto.utils";
import { createImageStableKey, createImageStoragePath } from "@/utils/image-storage.utils";
import { ImageDownloadPipeline } from "./image-download.pipeline";

const DATA = Buffer.from([1, 2, 3, 4]);
const SOURCE_HASH = createHash("sha256").update(DATA).digest("hex");
const STABLE_KEY = createImageStableKey({ ownerStableKey: "owner-key", imageType: "poster", sourceHash: SOURCE_HASH });
const STABLE_PATH = createImageStoragePath({ root: "/images", stableKey: STABLE_KEY, imageType: "poster" });
const URL = "https://example.test/poster.jpg";
const TARGET = { ownerStableKey: "owner-key" };

interface PipelineConfig {
	metadataFormat?: string | undefined;
	downloadSucceeds?: boolean | undefined;
	downloadError?: Error | undefined;
	writeSucceeds?: boolean | undefined;
}

interface PipelineSpies {
	downloads: Array<{ url: string; destination: string }>;
	deleted: string[];
	renamed: Array<[string, string]>;
	createdDirectories: string[];
	existingPaths: Set<string>;
	localReads: string[];
}

function createPipeline(config: PipelineConfig = {}): { pipeline: ImageDownloadPipeline; spies: PipelineSpies } {
	const spies: PipelineSpies = {
		downloads: [],
		deleted: [],
		renamed: [],
		createdDirectories: [],
		existingPaths: new Set(),
		localReads: [],
	};
	const pipeline = new ImageDownloadPipeline({
		download: async (url, destination, downloadOptions) => {
			spies.downloads.push({ url, destination });
			try {
				if (config.downloadSucceeds === false) throw config.downloadError ?? new Error("boom");

				await downloadOptions?.validate?.(destination);

				return true;
			} catch (error) {
				downloadOptions?.onError?.(error);

				return false;
			}
		},
		readLocalFile: (path: string) => {
			spies.localReads.push(path);

			return Promise.resolve(DATA);
		},
		getImageMetadata: async () => ({ format: config.metadataFormat ?? "png" }),
		optimizeImageWithInfo: async () => ({ data: DATA, info: { format: "webp", width: 320, height: 240, size: DATA.byteLength } }),
		writeFile: async () => config.writeSucceeds !== false,
		deleteFile: (path) => {
			spies.deleted.push(path);

			return Promise.resolve(true);
		},
		fileExists: async (path) => spies.existingPaths.has(path),
		renameFile: (from, to) => {
			spies.renamed.push([from, to]);

			return Promise.resolve();
		},
		createDirectory: (path) => {
			spies.createdDirectories.push(path);

			return Promise.resolve(true);
		},
		resolveVariant: (variant) => ({ width: variant === "poster" ? 1000 : 1920, height: null, quality: 75 }),
		imageTmpPath: () => "/images/.tmp",
		imagesRoot: () => "/images",
	});

	return { pipeline, spies };
}

describe("ImageDownloadPipeline", () => {
	test("downloads, optimizes and moves the image to its stable path", async () => {
		const { pipeline, spies } = createPipeline();

		const result = await pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster");

		expect(spies.downloads).toEqual([{ url: URL, destination: expect.any(String) }]);
		expect(result).toEqual({
			contentType: "image/webp",
			width: 320,
			height: 240,
			fileSize: DATA.byteLength,
			sourceHash: SOURCE_HASH,
			localPath: STABLE_PATH,
			stableKey: STABLE_KEY,
		});
		expect(spies.createdDirectories).toEqual(["/images/.tmp", "/images/posters"]);
		expect(spies.renamed).toHaveLength(2);
		const temporaryPath = spies.renamed[0]?.[1] ?? "";
		expect(spies.renamed).toEqual([
			[expect.any(String), temporaryPath],
			[temporaryPath, STABLE_PATH],
		]);
	});

	test("discards the temporary file when the stable path already exists", async () => {
		const { pipeline, spies } = createPipeline();
		spies.existingPaths.add(STABLE_PATH);

		const result = await pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster");

		expect(result.localPath).toBe(STABLE_PATH);
		expect(spies.renamed).toHaveLength(1);
		expect(spies.deleted.filter((path) => path.endsWith(".tmp"))).toHaveLength(2);
		expect(spies.deleted).toContain(spies.renamed[0]?.[1] ?? "");
	});

	test("throws a ValidationError with the download error when the download fails", async () => {
		const { pipeline, spies } = createPipeline({ downloadSucceeds: false, downloadError: new Error("storage dead") });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toThrow(
			"Cannot download a valid image from https://example.test/poster.jpg: storage dead",
		);
		expect(spies.deleted.filter((path) => path.endsWith(".tmp"))).toHaveLength(2);
	});

	test("rejects a download whose bytes carry no recognized image format", async () => {
		const { pipeline } = createPipeline({ metadataFormat: "" });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toThrow(
			"Downloaded file has no recognized image format",
		);
	});

	test("rejects formats outside the content-type allowlist", async () => {
		const { pipeline } = createPipeline({ metadataFormat: "dng" });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toThrow("Unsupported image format: dng");
	});

	test("throws an InternalError and cleans up temporaries when the optimized write fails", async () => {
		const { pipeline, spies } = createPipeline({ writeSucceeds: false });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toThrow("Cannot write optimized image");
		expect(spies.deleted.filter((path) => path.endsWith(".tmp"))).toHaveLength(2);
	});

	test("prepareLocalArtwork optimizes a local file through the same persist path", async () => {
		const { pipeline, spies } = createPipeline();

		const result = await pipeline.prepareLocalArtwork("/media/Movie/folder.jpg", TARGET, "poster", "poster");

		expect(spies.downloads).toEqual([]);
		expect(spies.localReads).toEqual(["/media/Movie/folder.jpg"]);
		expect(result).toEqual({
			contentType: "image/webp",
			width: 320,
			height: 240,
			fileSize: DATA.byteLength,
			sourceHash: SOURCE_HASH,
			localPath: STABLE_PATH,
			stableKey: STABLE_KEY,
		});
	});

	test("prepareLocalArtwork rejects a local file without a recognized format", async () => {
		const { pipeline } = createPipeline({ metadataFormat: "" });

		await expect(pipeline.prepareLocalArtwork("/media/Movie/folder.jpg", TARGET, "poster", "poster")).rejects.toThrow(
			"Local file has no recognized image format",
		);
	});
});
