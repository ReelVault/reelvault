import { describe, expect, test } from "bun:test";
import type { PersistedImageInput } from "@/database/repositories/images.repository";
import { ImageProcessingService } from "./image-processing.service";
import type { UploadedImage } from "./image-upload.service";

const PERSISTED: PersistedImageInput = {
	localPath: "/images/posters/persisted.webp",
	contentType: "image/webp",
	width: 320,
	height: 240,
	fileSize: 4,
	sourceHash: "source-hash",
	stableKey: "v1:local:stable",
};

const UPLOADED: UploadedImage = {
	localPath: "/images/.tmp/upload.webp",
	contentType: "image/webp",
	width: 100,
	height: 200,
	fileSize: 9,
	sourceHash: "upload-hash",
};

interface ServiceConfig {
	currentLocalPath?: string | undefined;
	fileExists?: boolean | undefined;
	downloadErrorFor?: ((url: string) => Error | undefined) | undefined;
}

function createService(config: ServiceConfig = {}) {
	const spies = {
		targetsFetched: [] as string[],
		downloads: [] as Array<{
			url: string;
			variant: string;
			imageType: string;
			target: { ownerStableKey: string; currentLocalPath?: string | undefined };
		}>,
		replaced: [] as Array<{ owner: string; stableKey: string }>,
		placedUploads: [] as Array<{ ownerStableKey: string; imageType: string; sourceHash: string }>,
		existenceChecks: [] as string[],
		localArtwork: [] as Array<{ sourcePath: string; variant: string; imageType: string; ownerStableKey: string }>,
	};
	const service = new ImageProcessingService({
		getMetadataTarget: (metadataId, type) => {
			spies.targetsFetched.push(`metadata:${metadataId}:${type}`);

			return Promise.resolve({ ownerStableKey: `meta:${metadataId}`, currentLocalPath: config.currentLocalPath });
		},
		replaceMetadataImage: (metadataId, _type, image) => {
			spies.replaced.push({ owner: metadataId, stableKey: image.stableKey });

			return Promise.resolve();
		},
		getSeasonTarget: (metadataId, seasonId) => {
			spies.targetsFetched.push(`season:${seasonId}`);

			return Promise.resolve({ ownerStableKey: `season:${metadataId}:${seasonId}`, currentLocalPath: config.currentLocalPath });
		},
		replaceSeasonImage: (_metadataId, seasonId, image) => {
			spies.replaced.push({ owner: seasonId, stableKey: image.stableKey });

			return Promise.resolve();
		},
		getEpisodeTarget: (metadataId, episodeId) => {
			spies.targetsFetched.push(`episode:${episodeId}`);

			return Promise.resolve({ ownerStableKey: `episode:${metadataId}:${episodeId}`, currentLocalPath: config.currentLocalPath });
		},
		replaceEpisodeImage: (_metadataId, episodeId, image) => {
			spies.replaced.push({ owner: episodeId, stableKey: image.stableKey });

			return Promise.resolve();
		},
		getPersonTarget: (personId) => {
			spies.targetsFetched.push(`person:${personId}`);

			return Promise.resolve({ ownerStableKey: `person:${personId}`, currentLocalPath: config.currentLocalPath });
		},
		replacePersonImage: (personId, image) => {
			spies.replaced.push({ owner: personId, stableKey: image.stableKey });

			return Promise.resolve();
		},
		getProfileAvatarTarget: (profileId) => {
			spies.targetsFetched.push(`profile:${profileId}`);

			return Promise.resolve({ ownerStableKey: `profile:${profileId}` });
		},
		replaceProfileAvatar: (profileId, image) => Promise.resolve({ imageId: image.stableKey, avatarUrl: `/avatars/${profileId}` }),
		fileExists: (path) => {
			spies.existenceChecks.push(path);

			return Promise.resolve(config.fileExists ?? true);
		},
		getSharpConcurrency: () => 2,
		downloadAndPrepare: (url, target, variant, imageType) => {
			spies.downloads.push({
				url,
				variant,
				imageType,
				target: { ownerStableKey: target.ownerStableKey, currentLocalPath: target.currentLocalPath },
			});
			const error = config.downloadErrorFor?.(url);

			return error ? Promise.reject(error) : Promise.resolve(PERSISTED);
		},
		placeAtStablePath: (localPath, source) => {
			spies.placedUploads.push({ ...source });

			return Promise.resolve({ localPath, stableKey: `${source.ownerStableKey}:${source.imageType}` });
		},
		prepareLocalArtwork: (sourcePath, target, variant, imageType) => {
			spies.localArtwork.push({ sourcePath, variant, imageType, ownerStableKey: target.ownerStableKey });

			return Promise.resolve(PERSISTED);
		},
	});

	return { service, spies };
}

describe("ImageProcessingService", () => {
	test("processSeason skips the download while the current poster still exists", async () => {
		const { service, spies } = createService({ currentLocalPath: "/images/posters/current.webp", fileExists: true });

		await service.processSeason({ metadataId: "m1", seasonId: "s1", imagesUrl: "https://x/poster.jpg" });

		expect(spies.existenceChecks).toEqual(["/images/posters/current.webp"]);
		expect(spies.downloads).toEqual([]);
		expect(spies.replaced).toEqual([]);
	});

	test("processSeason downloads and replaces when the current poster is missing", async () => {
		const { service, spies } = createService({ currentLocalPath: "/images/posters/current.webp", fileExists: false });

		await service.processSeason({ metadataId: "m1", seasonId: "s1", imagesUrl: "https://x/poster.jpg" });

		expect(spies.downloads).toEqual([
			{
				url: "https://x/poster.jpg",
				variant: "poster",
				imageType: "poster",
				target: { ownerStableKey: "season:m1:s1", currentLocalPath: "/images/posters/current.webp" },
			},
		]);
		expect(spies.replaced).toEqual([{ owner: "s1", stableKey: "v1:local:stable" }]);
	});

	test("processSeason ignores the existing file when force is set", async () => {
		const { service, spies } = createService({ currentLocalPath: "/images/posters/current.webp", fileExists: true });

		await service.processSeason({ metadataId: "m1", seasonId: "s1", imagesUrl: "https://x/poster.jpg", force: true });

		expect(spies.existenceChecks).toEqual([]);
		expect(spies.downloads).toHaveLength(1);
	});

	test("processSeason without an image URL is a no-op", async () => {
		const { service, spies } = createService();

		await service.processSeason({ metadataId: "m1", seasonId: "s1", imagesUrl: "" });

		expect(spies.targetsFetched).toEqual([]);
		expect(spies.downloads).toEqual([]);
	});

	test("processEpisode downloads the episode still as a backdrop variant under the poster image type", async () => {
		const { service, spies } = createService();

		await service.processEpisode({ metadataId: "m1", episodeId: "e1", imagesUrl: "https://x/still.jpg" });

		expect(spies.downloads).toEqual([
			{
				url: "https://x/still.jpg",
				variant: "backdrop",
				imageType: "poster",
				target: { ownerStableKey: "episode:m1:e1", currentLocalPath: undefined },
			},
		]);
		expect(spies.replaced).toEqual([{ owner: "e1", stableKey: "v1:local:stable" }]);
	});

	test("processPerson stores the portrait under the profile image type", async () => {
		const { service, spies } = createService();

		await service.processPerson("p1", "https://x/portrait.jpg");

		expect(spies.downloads).toEqual([
			{
				url: "https://x/portrait.jpg",
				variant: "poster",
				imageType: "profile",
				target: { ownerStableKey: "person:p1", currentLocalPath: undefined },
			},
		]);
		expect(spies.replaced).toEqual([{ owner: "p1", stableKey: "v1:local:stable" }]);
	});

	test("processPerson without a URL is a no-op", async () => {
		const { service, spies } = createService();

		await service.processPerson("p1", "");

		expect(spies.targetsFetched).toEqual([]);
	});

	test("processMetadata persists every URL-bearing image and skips blank entries", async () => {
		const { service, spies } = createService();

		await service.processMetadata("m1", [
			{ type: "poster", url: "https://x/poster.jpg" },
			{ type: "backdrop" },
			{ type: "backdrop", url: "https://x/backdrop.jpg" },
		]);

		expect(
			spies.downloads
				.toSorted((a, b) => a.url.localeCompare(b.url))
				.map((download) => ({
					url: download.url,
					variant: download.variant,
					imageType: download.imageType,
				})),
		).toEqual([
			{ url: "https://x/backdrop.jpg", variant: "backdrop", imageType: "backdrop" },
			{ url: "https://x/poster.jpg", variant: "poster", imageType: "poster" },
		]);
		expect(spies.replaced).toEqual([
			{ owner: "m1", stableKey: "v1:local:stable" },
			{ owner: "m1", stableKey: "v1:local:stable" },
		]);
	});

	test("a single dead provider URL does not abort the remaining metadata images", async () => {
		const { service, spies } = createService({ downloadErrorFor: (url) => (url.includes("dead") ? new Error("dead url") : undefined) });

		await service.processMetadata("m1", [
			{ type: "poster", url: "https://x/dead.jpg" },
			{ type: "backdrop", url: "https://x/alive.jpg" },
		]);

		expect(spies.downloads).toHaveLength(2);
		expect(spies.replaced).toEqual([{ owner: "m1", stableKey: "v1:local:stable" }]);
	});

	test("processMetadata rethrows when the signal is already aborted", async () => {
		const { service, spies } = createService();
		const controller = new AbortController();
		controller.abort();

		await expect(
			service.processMetadata("m1", [{ type: "poster", url: "https://x/poster.jpg" }], false, controller.signal),
		).rejects.toThrow();
		expect(spies.downloads).toEqual([]);
	});

	test("replaceProviderArtwork replaces only the provided paths without existence checks", async () => {
		const { service, spies } = createService();

		await service.replaceProviderArtwork("m1", { posterPath: "https://x/poster.jpg", backdropPath: null });

		expect(spies.downloads.map((download) => download.variant)).toEqual(["poster"]);
		expect(spies.downloads[0]?.target.ownerStableKey).toBe("meta:m1");
		expect(spies.existenceChecks).toEqual([]);
	});

	test("replaceMetadataImageWithUpload places the upload under the metadata owner key", async () => {
		const { service, spies } = createService();

		await service.replaceMetadataImageWithUpload("m1", "poster", UPLOADED);

		expect(spies.placedUploads).toEqual([{ ownerStableKey: "meta:m1", imageType: "poster", sourceHash: "upload-hash" }]);
		expect(spies.replaced).toEqual([{ owner: "m1", stableKey: "meta:m1:poster" }]);
	});

	test("replaceProfileAvatarWithUpload returns the avatar URL from the repository", async () => {
		const { service, spies } = createService();

		const result = await service.replaceProfileAvatarWithUpload("prof1", UPLOADED);

		expect(result).toEqual({ imageId: "profile:prof1:avatar", avatarUrl: "/avatars/prof1" });
		expect(spies.placedUploads).toEqual([{ ownerStableKey: "profile:prof1", imageType: "avatar", sourceHash: "upload-hash" }]);
	});

	test("processSeason reads sidecar artwork from a local path instead of downloading", async () => {
		const { service, spies } = createService();

		await service.processSeason({ metadataId: "m1", seasonId: "s1", imagesUrl: "/media/Alien/season01-poster.jpg" });

		expect(spies.localArtwork).toEqual([
			{ sourcePath: "/media/Alien/season01-poster.jpg", variant: "poster", imageType: "poster", ownerStableKey: "season:m1:s1" },
		]);
		expect(spies.downloads).toEqual([]);
		expect(spies.replaced).toEqual([{ owner: "s1", stableKey: PERSISTED.stableKey }]);
	});
});
