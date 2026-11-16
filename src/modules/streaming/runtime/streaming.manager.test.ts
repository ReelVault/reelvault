import { afterEach, describe, expect, test } from "bun:test";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { streamingManager } from "./streaming.manager";

const sessionIds: string[] = [];

const decision = createMockPlaybackDecision({ mode: "direct-stream", videoTranscode: false, audioTranscode: false, reason: "test" });

const noOp = (): void => {
	// intentionally empty
};
const noOpAsync = (): Promise<void> => Promise.resolve();

afterEach(async () => {
	await Promise.all(sessionIds.splice(0).map((sessionId) => streamingManager.discardSession(sessionId)));
	streamingManager.configureLifecycleCallbacks({
		cancelOperation: noOpAsync,
		onSessionStarted: noOp,
		onSessionEnded: noOp,
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

	test("tears down the attached process when a post-attach callback fails", async () => {
		const sessionId = "session-post-attach-failure";
		sessionIds.push(sessionId);
		streamingManager.registerSession(sessionId, {
			mediaFileId: "media-post-attach",
			profileId: "profile-post-attach",
			decision,
			inputPath: "/media/a.mkv",
		});

		const processManager: object = Reflect.get(streamingManager, "processManager");
		const stubs: MethodStub[] = [
			stubMethod(processManager, "startSession", () => {
				const store: { get(id: string): { generation: number } | undefined } = Reflect.get(streamingManager, "store");
				const session = store.get(sessionId);
				if (session) session.generation = 1;

				return Promise.resolve();
			}),
			stubMethod(processManager, "stopRunningProcess", noOpAsync),
			stubMethod(processManager, "removeTempDirectory", noOpAsync),
		];
		streamingManager.configureLifecycleCallbacks({
			cancelOperation: noOpAsync,
			onSessionStarted: () => {
				throw new Error("callback failed");
			},
			onSessionEnded: noOp,
		});

		try {
			await expect(streamingManager.startSession({ sessionId, inputPath: "/media/a.mkv", decision })).rejects.toBeInstanceOf(Error);
			expect(stubs[1]!.calls).toHaveLength(1);
		} finally {
			for (const stub of stubs.splice(0)) stub.restore();
		}
	});

	test("discarding a creating session removes it", async () => {
		const sessionId = "session-discard-creating";
		sessionIds.push(sessionId);
		streamingManager.registerSession(sessionId, {
			mediaFileId: "media-discard",
			profileId: "profile-discard",
			decision,
			inputPath: "/media/d.mkv",
		});

		await streamingManager.discardSession(sessionId);

		expect(streamingManager.getSessionAccess(sessionId)).toBeUndefined();
	});
});
