import { afterEach, describe, expect, test } from "bun:test";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { metadataMergeRepository } from "@/database/repositories/metadata-merge.repository";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { imageUploadService } from "@/modules/images/image-upload.service";
import { sidecarSyncService } from "@/modules/metadata-sidecars/sidecar-sync.service";
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
});
