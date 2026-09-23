import { describe, expect, test } from "bun:test";
import { SessionLifecyclePublisher } from "./session-events.publisher";

describe("session lifecycle publisher", () => {
	test("publishes the playback.lifecycle.started event", () => {
		const published: Array<{ event: string; payload: unknown }> = [];
		const publisher = new SessionLifecyclePublisher({
			pluginsService: {
				publish: (event: string, payload: unknown) => {
					published.push({ event, payload });
				},
			},
		});

		const event = {
			sessionId: "session-1",
			userId: "user-1",
			profileId: "profile-1",
			mediaFileId: "file-1",
			mode: "direct-stream" as const,
			videoCodec: "h264",
			audioCodec: "aac",
			videoBitrateKbps: 8000,
			audioStreamIndex: 1,
			startedAt: "2026-09-10T00:00:00.000Z",
		};
		publisher.publishStarted(event);

		expect(published).toEqual([{ event: "playback.lifecycle.started", payload: event }]);
	});
});
