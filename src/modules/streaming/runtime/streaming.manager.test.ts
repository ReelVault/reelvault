import { afterEach, describe, expect, test } from "bun:test";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { streamingManager } from "./streaming.manager";

const sessionIds: string[] = [];

const decision = createMockPlaybackDecision({ mode: "direct-stream", videoTranscode: false, audioTranscode: false, reason: "test" });

afterEach(() => {
	for (const sessionId of sessionIds.splice(0))
		streamingManager.discardSession(sessionId).catch(() => {
			/* intentionally empty */
		});
});

describe("streaming session isolation", () => {
	test("keeps ownership and media-file bindings separate for concurrent sessions", () => {
		const firstSessionId = "session-isolation-a";
		const secondSessionId = "session-isolation-b";
		sessionIds.push(firstSessionId, secondSessionId);

		streamingManager.registerSession(firstSessionId, {
			mediaFileId: "same-media-file",
			profileId: "profile-a",
			decision,
			inputPath: "/media/a.mkv",
		});
		streamingManager.registerSession(secondSessionId, {
			mediaFileId: "same-media-file",
			profileId: "profile-b",
			decision,
			inputPath: "/media/a.mkv",
		});

		expect(streamingManager.getSessionAccess(firstSessionId)).toEqual({ mediaFileId: "same-media-file", profileId: "profile-a" });
		expect(streamingManager.getSessionAccess(secondSessionId)).toEqual({ mediaFileId: "same-media-file", profileId: "profile-b" });
	});

	test("releases a session exactly once when cleanup races", async () => {
		const sessionId = "session-release-race";
		sessionIds.push(sessionId);
		streamingManager.registerSession(sessionId, {
			mediaFileId: "media-release",
			profileId: "profile-release",
			decision,
			inputPath: "/media/r.mkv",
		});

		const [firstRelease, secondRelease] = await Promise.all([
			streamingManager.releaseSession(sessionId, "client-release"),
			streamingManager.releaseSession(sessionId, "inactivity-timeout"),
		]);

		expect([firstRelease, secondRelease].toSorted()).toEqual(["already-ended", "released"]);
		expect(streamingManager.getSessionAccess(sessionId)).toBeUndefined();
	});

	test("a second release after teardown stays idempotent, unknown ids are reported", async () => {
		const sessionId = "session-idempotent-release";
		sessionIds.push(sessionId);
		streamingManager.registerSession(sessionId, {
			mediaFileId: "media-idempotent",
			profileId: "profile-release",
			decision,
			inputPath: "/media/i.mkv",
		});

		expect(await streamingManager.releaseSession(sessionId, "client-release")).toBe("released");
		expect(await streamingManager.releaseSession(sessionId, "client-release")).toBe("already-ended");
		expect(await streamingManager.releaseSession("never-existed", "client-release")).toBe("unknown");
	});

	test("discarding a creating session removes it; started sessions are kept", () => {
		const sessionId = "session-discard-creating";
		sessionIds.push(sessionId);
		streamingManager.registerSession(sessionId, {
			mediaFileId: "media-discard",
			profileId: "profile-discard",
			decision,
			inputPath: "/media/d.mkv",
		});

		streamingManager.discardSession(sessionId).catch(() => {
			/* intentionally empty */
		});
		expect(streamingManager.getSessionAccess(sessionId)).toBeUndefined();
		expect(streamingManager.hasActiveSession(sessionId)).toBe(false);
	});
});
