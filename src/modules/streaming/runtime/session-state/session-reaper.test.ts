import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { BufferAnalysisCache } from "../../buffer/buffer-analysis.cache";
import { SessionSeeker } from "../../seeking/session-seeker";
import { createMockPlaybackDecision } from "../../streaming.test-utils";
import { SessionReaper } from "./session-reaper";
import { SessionReservationTracker } from "./session-reservation.tracker";
import { SessionStore } from "./session-store";

function registration(store: SessionStore, id: string) {
	store.register({
		id,
		mediaFileId: `file-${id}`,
		profileId: "profile-1",
		decision: createMockPlaybackDecision({ mode: "transcode", videoTranscode: true, audioTranscode: false, reason: "test" }),
		inputPath: `/media/${id}.mkv`,
		tempDir: `/tmp/none/${id}`,
	});
}

function createReaper() {
	const store = new SessionStore();
	const reservations = new SessionReservationTracker(store, 5);
	const reaper = new SessionReaper(
		store,
		reservations,
		{
			removeTempDirectory: async () => {
				/* intentionally empty */
			},
		},
		new BufferAnalysisCache(4, () => "/tmp/none/playlist.m3u8"),
		new SessionSeeker(store, 1, async () => 0),
		{
			invalidate: () => {
				/* intentionally empty */
			},
			clear: () => {
				/* intentionally empty */
			},
		},
		new Set<string>(),
	);

	return { reaper, store, reservations };
}

describe("session reaper", () => {
	test("finalizeRelease cleans all state and records a terminated session", async () => {
		const { reaper, store, reservations } = createReaper();
		registration(store, "s1");
		store.setSessionOperation("s1", "op-1");
		reservations.reserve("s1", "user-1");
		const proc = spawn(["sleep", "100"]);
		store.attachProcess("s1", proc, 0);

		const cancelledOperations: string[] = [];
		const ended: unknown[] = [];
		await reaper.finalizeRelease(
			"s1",
			"admin-stop",
			{ tempRootDir: "/tmp/none" },
			{
				cancelOperation: (operationId) => {
					cancelledOperations.push(operationId);

					return Promise.resolve();
				},
				onSessionStarted: () => {
					/* intentionally empty */
				},
				onSessionEnded: (session) => ended.push(session),
			},
		);

		expect(cancelledOperations).toEqual(["op-1"]);
		expect(store.has("s1")).toBe(false);
		expect(store.getTerminatedSession("s1")?.reason).toBe("admin-stop");
		expect(store.isProfileTerminatedRecently("profile-1", "file-s1", 1_000)).toEqual({ reason: "admin-stop" });
		expect(ended).toEqual([{ sessionId: "s1", mediaFileId: "file-s1", profileId: "profile-1", reason: "admin-stop" }]);
	});

	test("finalizeRelease of a never-started session skips the ended lifecycle event", async () => {
		const { reaper, store } = createReaper();
		registration(store, "s1");

		const ended: unknown[] = [];
		await reaper.finalizeRelease(
			"s1",
			"reservation-deadline",
			{ tempRootDir: "/tmp/none" },
			{
				cancelOperation: async () => {
					/* intentionally empty */
				},
				onSessionStarted: () => {
					/* intentionally empty */
				},
				onSessionEnded: (session) => ended.push(session),
			},
		);

		expect(store.has("s1")).toBe(false);
		expect(ended).toEqual([]);
	});

	test("finalizeRelease survives a missing entry (already discarded)", async () => {
		const { reaper } = createReaper();

		await expect(
			reaper.finalizeRelease(
				"ghost",
				"shutdown",
				{ tempRootDir: "/tmp/none" },
				{
					cancelOperation: async () => {
						/* intentionally empty */
					},
					onSessionStarted: () => {
						/* intentionally empty */
					},
					onSessionEnded: () => {
						/* intentionally empty */
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test("shutdown releases every tracked session and clears the state", async () => {
		const { reaper, store, reservations } = createReaper();
		registration(store, "s1");
		registration(store, "s2");

		const released: Array<{ sessionId: string; reason: string }> = [];
		await reaper.shutdown((sessionId, reason) => {
			released.push({ sessionId, reason });

			return Promise.resolve("released");
		});

		expect(released).toEqual([
			{ sessionId: "s1", reason: "shutdown" },
			{ sessionId: "s2", reason: "shutdown" },
		]);
		expect(store.size).toBe(0);
		expect(reservations.reservedCount).toBe(0);
	});
});
