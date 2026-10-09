import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("me client resets progress for one file or for its whole title", async () => {
	const requestedUrls: string[] = [];
	const client = createTestClient(
		(url) => {
			requestedUrls.push(url);

			return jsonResponse({ success: true });
		},
		{ enableRetry: false },
	);

	await client.me.resetPlaybackProgress("file-1", { scope: "file" });
	await client.me.resetPlaybackProgress("file-2");

	expect(requestedUrls).toEqual([
		"https://reelvault.test/v1/me/media-files/file-1/playback-progress?scope=file",
		"https://reelvault.test/v1/me/media-files/file-2/playback-progress",
	]);
});

test("me client sends bulk watch state changes as one request", async () => {
	const requests: Array<{ url: string; method: string | undefined; body: string | null }> = [];
	const client = createTestClient(
		(url, init) => {
			requests.push({ url, method: init.method, body: typeof init.body === "string" ? init.body : null });

			return jsonResponse({ updated: 2 });
		},
		{ enableRetry: false },
	);

	await expect(client.me.setWatchStateBulk({ mediaFileIds: ["file-1", "file-2"], watched: true })).resolves.toEqual({ updated: 2 });

	expect(requests).toEqual([
		{
			url: "https://reelvault.test/v1/me/watch-state/bulk",
			method: "POST",
			body: JSON.stringify({ mediaFileIds: ["file-1", "file-2"], watched: true }),
		},
	]);
});
