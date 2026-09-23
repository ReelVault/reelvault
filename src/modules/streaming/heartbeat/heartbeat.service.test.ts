import { describe, expect, test } from "bun:test";
import type { SessionLifecycleState } from "@reelvault/sdk/common";
import { HeartbeatService } from "./heartbeat.service";

function createService(
	options: { progressWriteFails?: boolean; sessionState?: { state: SessionLifecycleState; generation: number } } = {},
) {
	const calls = {
		keptAlive: [] as string[],
		progressUpdates: [] as Array<{ fileId: string; progress: unknown; profileId: string | undefined }>,
		sessionEvents: [] as Array<{ sessionId: string; event: string; payload: unknown }>,
	};
	const service = new HeartbeatService({
		requireSession: () => ({ mediaFileId: "file-1", profileId: "profile-1" }),
		keepAlive: (sessionId) => {
			calls.keptAlive.push(sessionId);
		},
		getSessionState: () => options.sessionState ?? { state: "active", generation: 1 },
		updatePlaybackProgress: (fileId, progress, profileId) => {
			if (options.progressWriteFails) return Promise.reject(new Error("progress write failed"));

			calls.progressUpdates.push({ fileId, progress, profileId });

			return Promise.resolve({ success: true });
		},
		sendSessionEvent: (sessionId, event, payload) => {
			calls.sessionEvents.push({ sessionId, event, payload });
		},
	});

	return { service, calls };
}

describe("heartbeat service", () => {
	test("keeps the session alive and returns an ok heartbeat with the session state", async () => {
		const { service, calls } = createService({ sessionState: { state: "active", generation: 3 } });

		const result = await service.execute("s1");

		expect(result.status).toBe("ok");
		expect(result.sessionId).toBe("s1");
		expect(result.state).toBe("active");
		expect(result.generation).toBe(3);
		expect(typeof result.timestamp).toBe("string");
		expect(calls.keptAlive).toEqual(["s1"]);
		expect(calls.progressUpdates).toEqual([]);
	});

	test("reports a creating session while the first process is still starting", async () => {
		const { service } = createService({ sessionState: { state: "creating", generation: 0 } });

		const result = await service.execute("s1");

		expect(result.state).toBe("creating");
		expect(result.generation).toBe(0);
	});

	test("writes progress only for a finite position", async () => {
		const { service, calls } = createService();

		await service.execute("s1", { position: 120, audioStreamIndex: 1 });
		await service.execute("s1", { position: null });
		await service.execute("s1", { position: Number.NaN });

		expect(calls.progressUpdates).toEqual([{ fileId: "file-1", progress: { position: 120, audioStreamIndex: 1 }, profileId: "profile-1" }]);
	});

	test("a failed progress write does not break the heartbeat", async () => {
		const { service } = createService({ progressWriteFails: true });

		const result = await service.execute("s1", { position: 10 });

		expect(result.status).toBe("ok");
	});

	test("emits playback:session:progress event when position or isPaused is provided", async () => {
		const { service, calls } = createService();

		await service.execute("s1", { position: 45, duration: 120, isPaused: false });

		expect(calls.sessionEvents).toEqual([
			{
				sessionId: "s1",
				event: "playback:session:progress",
				payload: { sessionId: "s1", position: 45, duration: 120, isPaused: false },
			},
		]);
	});
});
