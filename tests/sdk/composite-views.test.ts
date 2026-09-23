import { expect, test } from "bun:test";
import { ReelVaultClient } from "@sdk/client";

test("composite views client endpoints work as expected", async () => {
	const requests: string[] = [];
	const client = new ReelVaultClient({
		baseUrl: "https://reelvault.test/v1",
		enableRetry: false,
		fetcher: (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(url)}`);

			return Promise.resolve(new Response(JSON.stringify({ test: "ok" }), { headers: { "content-type": "application/json" } }));
		},
	});

	await client.playbackSessions.getView("media-file-123");
	await client.metadata.getDetailsView("metadata-456");

	expect(requests).toEqual([
		"GET https://reelvault.test/v1/playback-sessions/view/media-file-123",
		"GET https://reelvault.test/v1/metadata/metadata-456/details-view",
	]);
});
