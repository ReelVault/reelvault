import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("composite views client endpoints work as expected", async () => {
	const requests: string[] = [];
	const client = createTestClient(
		(url, init) => {
			requests.push(`${init?.method ?? "GET"} ${url}`);

			return jsonResponse({ test: "ok" });
		},
		{ enableRetry: false },
	);

	await client.playbackSessions.getView("media-file-123");
	await client.metadata.getDetailsView("metadata-456");

	expect(requests).toEqual([
		"GET https://reelvault.test/v1/playback-sessions/view/media-file-123",
		"GET https://reelvault.test/v1/metadata/metadata-456/details-view",
	]);
});
