import { afterEach, expect, test } from "bun:test";
import { metadataRefreshService } from "@/application/catalog/metadata/metadata-refresh.runtime";
import { getCachedResponseBody, responseCacheKey, setCachedResponseBody } from "@/utils/response-body-cache";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { refreshMetadataTask } from "./metadata-refresh.worker";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const listKey = responseCacheKey({ pathWithQuery: "/v1/metadata?page=1", cookie: "", profileId: "", auth: "", apiKey: "" });
const unrelatedKey = responseCacheKey({ pathWithQuery: "/v1/admin/settings", cookie: "", profileId: "", auth: "", apiKey: "" });

test("a metadata refresh flushes cached catalog lists but leaves unrelated responses alone", async () => {
	stubs.push(stubMethod(metadataRefreshService, "refresh", () => Promise.resolve({ metadataId: "m1", providerId: "tmdb" })));
	const body = { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() };
	setCachedResponseBody(listKey, body);
	setCachedResponseBody(unrelatedKey, body);

	await refreshMetadataTask({ metadataId: "m1" });

	expect(getCachedResponseBody(listKey)).toBeUndefined();
	expect(getCachedResponseBody(unrelatedKey)).toBeDefined();
});
