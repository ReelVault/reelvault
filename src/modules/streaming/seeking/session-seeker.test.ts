import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { SessionStore } from "@/modules/streaming/runtime/session-state/session.store";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { SessionSeeker } from "./session.seeker";

const decision = createMockPlaybackDecision({ mode: "transcode", durationSeconds: 600 });

function registeredSession(store: SessionStore, id: string, startTime: number) {
	store.register({
		id,
		mediaFileId: `file-${id}`,
		profileId: "profile-1",
		decision: createMockPlaybackDecision({ mode: "transcode", durationSeconds: 600 }),
		inputPath: `/media/${id}.mkv`,
		tempDir: `/tmp/transcodes/${id}`,
	});
	store.attachProcess(id, spawn(["true"]), startTime);
}

describe("session seeker", () => {
	test("rejects seeks for unknown sessions", async () => {
		const store = new SessionStore();
		const seeker = new SessionSeeker(store, 1, () => Promise.resolve(0));

		await expect(
			seeker.seekTo("missing", 10, decision, 4, {
				getBufferedSeekStart: async () => null,
				keepAlive: () => {
					/* intentionally empty */
				},
			}),
		).rejects.toMatchObject({ category: "not_found", code: "stream.session_not_found" });
	});

	test("reuses the buffer when the position is already buffered", async () => {
		const store = new SessionStore();
		registeredSession(store, "s1", 30);
		const seeker = new SessionSeeker(store, 1, () => Promise.reject(new Error("executor must not run")));
		const keepAliveIds: string[] = [];

		const result = await seeker.seekTo("s1", 20, decision, 4, {
			getBufferedSeekStart: async () => 16,
			keepAlive: (id) => keepAliveIds.push(id),
		});

		expect(result).toEqual({ startTime: 30, reusedBuffer: true });
		expect(keepAliveIds).toEqual(["s1"]);
	});

	test("aligns the seek offset down to a segment boundary and executes it", async () => {
		const store = new SessionStore();
		registeredSession(store, "s1", 0);
		const executed: Array<{ sessionId: string; offset: number }> = [];
		const seeker = new SessionSeeker(store, 1, (sessionId, offset) => {
			executed.push({ sessionId, offset });

			return Promise.resolve(offset);
		});

		const result = await seeker.seekTo("s1", 123.7, decision, 4, {
			getBufferedSeekStart: async () => null,
			keepAlive: () => {
				/* intentionally empty */
			},
		});

		expect(result.startTime).toBe(120);
		expect(executed).toEqual([{ sessionId: "s1", offset: 120 }]);
	});

	test("clamps a seek past the duration to the EOF guard before aligning it", async () => {
		const store = new SessionStore();
		registeredSession(store, "s1", 0);
		const executed: number[] = [];
		const seeker = new SessionSeeker(store, 1, (_sessionId, offset) => {
			executed.push(offset);

			return Promise.resolve(offset);
		});

		const result = await seeker.seekTo("s1", 900, decision, 4, {
			getBufferedSeekStart: async () => null,
			keepAlive: () => {
				/* intentionally empty */
			},
		});

		// 900 clamps to 599 (duration minus the 1 s EOF guard), which aligns down to 596.
		expect(result.startTime).toBe(596);
		expect(executed).toEqual([596]);
	});

	test("negative positions clamp to zero", async () => {
		const store = new SessionStore();
		registeredSession(store, "s1", 0);
		const seeker = new SessionSeeker(store, 1, (_sessionId, offset) => Promise.resolve(offset));

		const result = await seeker.seekTo("s1", -50, decision, 4, {
			getBufferedSeekStart: async () => null,
			keepAlive: () => {
				/* intentionally empty */
			},
		});

		expect(result.startTime).toBe(0);
	});

	test("alignToSegment floors to segment boundaries", () => {
		const store = new SessionStore();
		const seeker = new SessionSeeker(store, 1, () => Promise.resolve(0));

		expect(seeker.alignToSegment(7, 4)).toBe(4);
		expect(seeker.alignToSegment(8, 4)).toBe(8);
		expect(seeker.alignToSegment(-3, 4)).toBe(0);
	});
});
