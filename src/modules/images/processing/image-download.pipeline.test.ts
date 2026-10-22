import { describe, expect, test } from "bun:test";
import { ImageDownloadPipeline } from "./image-download.pipeline";

const DATA = Buffer.from([1, 2, 3, 4]);
// Derived by hand from the storage algorithm, so a change in the key or path
// format breaks this test instead of being mirrored by it:
// sha256([1,2,3,4]) → source hash; the key is "v1:local:" + hex("image") +
// hex("owner-key:poster:<source hash>"); the path is "/images/posters/" +
// sha256(<key>) + ".webp".
const SOURCE_HASH = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const STABLE_KEY =
	"v1:local:696d616765:6f776e65722d6b65793a706f737465723a39663634613734376531623937663133316661626236623434373239366339623666303230316537396662336335333536653663373765383962366138303661";
const STABLE_PATH = "/images/posters/9c414d6046be20fa889ea6071f6d0b7bf20c6519e63fa3dc3bab31e703701116.webp";
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
	localCopies: Array<{ from: string; to: string }>;
}

function createPipeline(config: PipelineConfig = {}): { pipeline: ImageDownloadPipeline; spies: PipelineSpies } {
	const spies: PipelineSpies = {
		downloads: [],
		deleted: [],
		renamed: [],
		createdDirectories: [],
		existingPaths: new Set(),
		localCopies: [],
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
		copyLocalFile: (from: string, to: string) => {
			spies.localCopies.push({ from, to });

			return Promise.resolve();
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

	test("rejects a failed download with its coded validation error and removes the temporary files", async () => {
		const { pipeline, spies } = createPipeline({ downloadSucceeds: false, downloadError: new Error("storage dead") });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toMatchObject({
			category: "validation",
			code: "images.download_failed",
		});
		expect(spies.deleted.filter((path) => path.endsWith(".tmp"))).toHaveLength(2);
	});

	test("rejects a download whose bytes carry no recognized image format", async () => {
		const { pipeline } = createPipeline({ metadataFormat: "" });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toMatchObject({
			category: "validation",
			code: "images.download_failed",
		});
	});

	test("rejects formats outside the content-type allowlist", async () => {
		const { pipeline } = createPipeline({ metadataFormat: "dng" });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toMatchObject({
			category: "validation",
			code: "images.download_failed",
		});
	});

	test("throws an InternalError and cleans up temporaries when the optimized write fails", async () => {
		const { pipeline, spies } = createPipeline({ writeSucceeds: false });

		await expect(pipeline.downloadAndPrepare(URL, TARGET, "poster", "poster")).rejects.toMatchObject({
			category: "internal",
			code: "image.write_failed",
		});
		expect(spies.deleted.filter((path) => path.endsWith(".tmp"))).toHaveLength(2);
	});

	test("prepareLocalArtwork optimizes a local file through the same persist path", async () => {
		const { pipeline, spies } = createPipeline();

		const result = await pipeline.prepareLocalArtwork("/media/Movie/folder.jpg", TARGET, "poster", "poster");

		expect(spies.downloads).toEqual([]);
		expect(spies.localCopies).toEqual([{ from: "/media/Movie/folder.jpg", to: expect.any(String) }]);
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

		await expect(pipeline.prepareLocalArtwork("/media/Movie/folder.jpg", TARGET, "poster", "poster")).rejects.toMatchObject({
			category: "validation",
			code: "images.format_unrecognized",
		});
	});
});
