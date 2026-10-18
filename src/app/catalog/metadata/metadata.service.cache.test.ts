import { afterEach, describe, expect, test } from "bun:test";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { imageUploadService } from "@/modules/images/image-upload.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
import { providerService } from "@/plugins/capabilities/provider.service";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { insertMetadata, insertMetadataProviders, insertProviders } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { metadataService } from "./metadata.service";

// Titles, provider links, merges, deletes and orphan purges run against the migrated test database.
// Stubbed: image upload and processing (file storage and image work), the provider's image list
// (a network read), and the sidecar scheduler (sidecar files on disk).
const db = useTestDatabase();

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const key = responseCacheKey({ pathWithQuery: "/v1/metadata?cache-test", cookie: "", profileId: "", auth: "", apiKey: "" });

function seedCachedResponse(): void {
	setCachedResponseBody(key, { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() });
}

async function seedMovie(id: string): Promise<void> {
	await insertMetadata(db.client(), { id, stableKey: id, title: id, type: "movie", releaseDate: "2020-01-01" });
}

async function linkProvider(metadataId: string, name: string, externalId: string): Promise<void> {
	const [provider] = await insertProviders(db.client(), { stableKey: `${name}-${externalId}`, name, entityType: "movie", externalId });
	if (!provider) throw new Error("Expected the provider insert to return a row");
	await insertMetadataProviders(db.client(), { metadataId, providerId: provider.id });
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
		await seedMovie("target");
		await seedMovie("source");
		stubs.push(stubMethod(sidecarSyncService, "scheduleSync", () => undefined));
		seedCachedResponse();

		await metadataService.mergeMetadata("target", "source");

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("choosing artwork that a provider offers", async () => {
		await seedMovie("m1");
		await linkProvider("m1", "tmdb", "550");
		stubs.push(
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
		seedCachedResponse();

		await metadataService.create({ title: "New title", type: "movie", releaseDate: "2020-01-01" });

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("deleting a title", async () => {
		await seedMovie("m1");
		seedCachedResponse();

		await metadataService.delete("m1");

		expect(getCachedResponseBody(key)).toBeUndefined();
	});

	test("purging orphaned titles", async () => {
		// A title with no media file is an orphan.
		await seedMovie("orphan-1");
		seedCachedResponse();

		await expect(metadataService.deleteOrphans()).resolves.toEqual({ count: 1 });

		expect(getCachedResponseBody(key)).toBeUndefined();
	});
});
