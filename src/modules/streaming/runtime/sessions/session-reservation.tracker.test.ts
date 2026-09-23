import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { createMockPlaybackDecision } from "../../streaming.test-utils";
import { SessionReservationTracker } from "./session-reservation.tracker";
import { SessionStore } from "./session-store";

function registration(store: SessionStore, id: string) {
	store.register({
		id,
		mediaFileId: `file-${id}`,
		profileId: "profile-1",
		decision: createMockPlaybackDecision({ mode: "direct-stream" }),
		inputPath: `/media/${id}.mkv`,
		tempDir: `/tmp/transcodes/${id}`,
	});
}

function attach(store: SessionStore, id: string) {
	store.attachProcess(id, spawn(["true"]), 0);
}

describe("session reservation tracker", () => {
	test("reserves within the global session limit and rejects beyond it", () => {
		const store = new SessionStore();
		const reservations = new SessionReservationTracker(store, 2);

		expect(reservations.reserve("s1")).toBe(true);
		expect(reservations.reserve("s2")).toBe(true);
		expect(reservations.reserve("s3")).toBe(false);
		expect(reservations.reservedCount).toBe(2);
	});

	test("counts running sessions against the limit", () => {
		const store = new SessionStore();
		registration(store, "running");
		attach(store, "running");
		const reservations = new SessionReservationTracker(store, 1);

		expect(reservations.reserve("new")).toBe(false);
	});

	test("does not double-count a session that is both attached and force-reserved (seek restart)", () => {
		const store = new SessionStore();
		registration(store, "s1");
		attach(store, "s1");
		const reservations = new SessionReservationTracker(store, 2);
		// A seek restart force-reserves the slot of a still-attached session.
		reservations.forceReserve("s1");

		// active=1 + reservedNotActive=0 < 2 — must not be rejected as if 2 slots were used.
		expect(reservations.reserve("s2")).toBe(true);
	});

	test("enforces the per-user limit counting reserved sessions", () => {
		const store = new SessionStore();
		const reservations = new SessionReservationTracker(store, 10, () => 2);
		reservations.forceReserve("r1", "user-1");

		expect(reservations.reserve("r2", "user-1")).toBe(true);
		expect(reservations.reserve("r3", "user-1")).toBe(false);

		reservations.release("r1");
		expect(reservations.reserve("r3", "user-1")).toBe(true);
	});

	test("re-reserving an already allocated session is a no-op that succeeds", () => {
		const store = new SessionStore();
		const reservations = new SessionReservationTracker(store, 1);

		expect(reservations.reserve("s1")).toBe(true);
		expect(reservations.reserve("s1")).toBe(true);
		expect(reservations.reservedCount).toBe(1);
	});

	test("release drops the reservation and the user binding only when not running", () => {
		const store = new SessionStore();
		const reservations = new SessionReservationTracker(store, 5);
		reservations.reserve("s1", "user-1");

		reservations.release("s1");
		expect(reservations.getUserForSession("s1")).toBeUndefined();

		reservations.reserve("s2", "user-1");
		registration(store, "s2");
		attach(store, "s2");
		reservations.release("s2");
		expect(reservations.getUserForSession("s2")).toBe("user-1");
	});

	test("markStarted clears the pending reservation state", () => {
		const store = new SessionStore();
		const reservations = new SessionReservationTracker(store, 5);
		reservations.reserve("s1");

		expect(reservations.isPending("s1")).toBe(true);
		registration(store, "s1");
		attach(store, "s1");
		reservations.markStarted("s1");
		expect(reservations.isPending("s1")).toBe(false);
	});

	test("resolvers are evaluated lazily", () => {
		const store = new SessionStore();
		let maxSessions = 1;
		const reservations = new SessionReservationTracker(store, () => maxSessions);

		expect(reservations.reserve("s1")).toBe(true);
		maxSessions = 5;
		expect(reservations.reserve("s2")).toBe(true);
	});
});
