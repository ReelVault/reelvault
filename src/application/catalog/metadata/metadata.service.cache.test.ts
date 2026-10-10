import { afterEach, describe, expect, test } from "bun:test";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataMergeRepository } from "@/database/repositories/metadata-merge.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { imageUploadService } from "@/modules/images/image-upload.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { metadataService } from "./metadata.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const key = responseCacheKey({ pathWithQuery: "/v1/metadata?cache-test", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedResponse(): void {
	setCachedResponseBody(key, { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() });
	expect(getCachedResponseBody(key)).toBeDefined();
}

describe("metadataService write paths flush cached API responses", () => {
	test("uploading artwork", async () => {
		stubs.push(
			stubMethod(imageUploadService, "upload", () => Promise.resolve({})),
			stubMethod(imageProcessingService, "replaceMetadataImageWithUpload", () => Promise.resolve()),
		);
		seedCachedResponse();

		await metadataService.uploadImage("m1", "poster", new File(["x"], "poster.png"));

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("merging two titles", async () => {
		stubs.push(
			stubMethod(metadataRepository, "findByIdForRead", () => Promise.resolve({ id: "x", type: "movie" })),
			stubMethod(metadataMergeRepository, "merge", () => Promise.resolve()),
			stubMethod(sidecarSyncService, "scheduleSync", () => undefined),
		);
		seedCachedResponse();

		await metadataService.mergeMetadata("a", "b");

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("choosing artwork that a provider offers", async () => {
		stubs.push(
			stubMethod(metadataRepository, "findProviderDetails", () =>
				Promise.resolve({ id: "m1", type: "movie", providers: [{ name: "tmdb", entityType: "movie", externalId: "550" }] }),
			),
			stubMethod(providerService, "fetchImagesByProvider", () =>
				Promise.resolve([{ type: "poster", url: "https://image.example/poster.jpg" }]),
			),
			stubMethod(imageProcessingService, "replaceMetadataImage", () => Promise.resolve()),
		);
		seedCachedResponse();

		await metadataService.selectImage("m1", { providerId: "tmdb", type: "poster", url: "https://image.example/poster.jpg" });

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("creating a title", async () => {
		stubs.push(stubMethod(metadataRepository, "createAndRead", () => Promise.resolve({ id: "m-new" })));
		seedCachedResponse();

		await metadataService.create({ title: "New title", type: "movie", releaseDate: "2020-01-01" });

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("deleting a title", async () => {
		stubs.push(
			stubMethod(metadataRepository, "findByIdForRead", () => Promise.resolve({ id: "m1", type: "movie" })),
			stubMethod(metadataRepository, "deleteAndGetCleanup", () => Promise.resolve({ artifactStorageKeys: [], subtitleFilePaths: [] })),
		);
		seedCachedResponse();

		await metadataService.delete("m1");

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("purging orphaned titles", async () => {
		let page = 0;
		stubs.push(
			stubMethod(metadataRepository, "findOrphanIds", () => Promise.resolve(page++ === 0 ? ["orphan-1"] : [])),
			stubMethod(metadataRepository, "deleteOrphansByIds", () => Promise.resolve(1)),
		);
		seedCachedResponse();

		await metadataService.deleteOrphans();

		expect(getCachedResponseBody(key)).toBeUndefined();
	});
});
