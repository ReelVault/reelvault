import { afterEach, expect, test } from "bun:test";
import { getCachedResponseBody, invalidateResponseBodies, responseCacheKey, setCachedResponseBody } from "@/utils/response-body.cache";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { selectMediaFiles } from "../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { mediaService } from "./media-files.service";

const db = useTestDatabase();

const metadataListKey = responseCacheKey({ pathWithQuery: "/v1/metadata?limit=20", cookie: "", profileId: "", auth: "", apiKey: "" });

afterEach(() => {
	invalidateResponseBodies();
});

test("moving a file to another movie stores the new title and drops the cached title lists", async () => {
	const mediaFileId = await insertMovieMediaFile(db.client(), "/movies/wrong.mkv", "wrong-title");
	await insertMovieMediaFile(db.client(), "/movies/right.mkv", "right-title");
	setCachedResponseBody(metadataListKey, { etag: "e", body: "[]", expiresAt: Date.now() + 60_000, encoded: new Map() });

	await mediaService.reassign(mediaFileId, { targetMetadataId: "right-title" });

	expect((await selectMediaFiles(db.client())).find((row) => row.id === mediaFileId)).toMatchObject({ metadataId: "right-title" });
	expect(getCachedResponseBody(metadataListKey)).toBeUndefined();
});
