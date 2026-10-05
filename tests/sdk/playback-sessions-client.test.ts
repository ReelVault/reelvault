import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("playback session client sends raw capabilities and retries with one idempotency key", async () => {
	const requests: Array<{ url: string; options: RequestInit }> = [];
	const client = createTestClient(
		(url, options) => {
			requests.push({ url, options });
			if (requests.length === 1) {
				return jsonResponse({ message: "temporarily unavailable" }, 503);
			}

			return jsonResponse({ sessionId: "session-1" });
		},
		{ maxRetries: 1 },
	);

	await expect(
		client.playbackSessions.create({ mediaFileId: "file-1", videoCodecs: [" H265 ", "h264", "H265"], audioCodecs: ["AAC", "aac"] }),
	).resolves.toMatchObject({ sessionId: "session-1" });

	expect(requests.map((request) => request.url)).toEqual([
		"https://reelvault.test/v1/playback-sessions",
		"https://reelvault.test/v1/playback-sessions",
	]);
	expect(requests.map((request) => new Headers(request.options.headers).get("idempotency-key"))).toEqual([
		expect.any(String),
		expect.any(String),
	]);
	expect(new Headers(requests[0]?.options.headers).get("idempotency-key")).toBe(
		new Headers(requests[1]?.options.headers).get("idempotency-key"),
	);
	expect(requests[0]?.options.body).toBe('{"mediaFileId":"file-1","videoCodecs":[" H265 ","h264","H265"],"audioCodecs":["AAC","aac"]}');
});

test("playback session URLs and profile playback endpoints use their resource boundaries", async () => {
	const requestedUrls: string[] = [];
	const client = createTestClient(
		(url) => {
			requestedUrls.push(url);

			return jsonResponse({ success: true });
		},
		{ baseUrl: "https://reelvault.test/app", enableRetry: false },
	);

	expect(client.playbackSessions.getPlaylistUrl("session-1")).toBe("https://reelvault.test/v1/playback-sessions/session-1/playlist");
	await client.me.updatePlaybackProgress("file-1", { position: 12 });

	expect(requestedUrls).toEqual(["https://reelvault.test/v1/me/media-files/file-1/playback-progress"]);
});
