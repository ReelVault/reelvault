import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "bun";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { SessionStore } from "./session.store";

/** Date.now stub for the terminated-history aging test; restored after every test. */
let dateStub: MethodStub | undefined;

afterEach(() => {
	dateStub?.restore();
	dateStub = undefined;
});

function registration(id: string, overrides: Partial<Parameters<SessionStore["register"]>[0]> = {}) {
	return {
		id,
		mediaFileId: `file-${id}`,
		profileId: "profile-1",
		decision: createMockPlaybackDecision({ mode: "direct-stream", videoTranscode: false, audioTranscode: false, reason: "test" }),
		inputPath: `/media/${id}.mkv`,
		tempDir: `/tmp/transcodes/${id}`,
		...overrides,
	};
}

function fakeProcess(): Bun.Subprocess {
	return spawn(["true"]);
}

describe("session store", () => {
	test("register creates a creating entity with decision bound from the start", () => {
		const store = new SessionStore();
		const session = store.register(registration("s1"));

		expect(session.state).toBe("creating");
		expect(session.generation).toBe(0);
		expect(session.process).toBeNull();
		expect(session.mode).toBe("direct-stream");
		expect(store.has("s1")).toBe(true);
		expect(store.values()).toHaveLength(1);
		expect(store.attachedCount()).toBe(0);
	});

	test("caps software video transcodes across pending and registered sessions", () => {
		const store = new SessionStore();
		const decision = createMockPlaybackDecision({ mode: "transcode", videoTranscode: true, audioTranscode: false, reason: "test" });

		expect(store.tryReserveSoftwareTranscode("pending", 1)).toBe(true);
		expect(store.tryReserveSoftwareTranscode("other", 1)).toBe(false);
		store.register(registration("pending", { decision, softwareVideoTranscode: true }));
		expect(store.tryReserveSoftwareTranscode("other", 1)).toBe(false);

		store.delete("pending");
		expect(store.tryReserveSoftwareTranscode("other", 1)).toBe(true);
		store.releaseSoftwareTranscode("other");
		expect(store.countSoftwareVideoTranscodes()).toBe(0);
	});

	test("register refuses a duplicate id", () => {
		const store = new SessionStore();
		store.register(registration("s1"));

		expect(() => store.register(registration("s1"))).toThrow(
			expect.objectContaining({ category: "conflict", code: "stream.session_exists" }),
		);
	});

	test("attachProcess moves creating → active and bumps the generation", () => {
		const store = new SessionStore();
		store.register(registration("s1"));

		store.attachProcess("s1", fakeProcess(), 120);

		const session = store.get("s1");
		expect(session?.state).toBe("active");
		expect(session?.generation).toBe(1);
		expect(session?.startTime).toBe(120);
		expect(store.attachedCount()).toBe(1);
		expect(store.isAttached("s1")).toBe(true);
	});

	test("attachProcess refuses a session whose release was claimed — no resurrection", () => {
		const store = new SessionStore();
		store.register(registration("s1"));
		store.claimRelease("s1");

		expect(() => store.attachProcess("s1", fakeProcess(), 0)).toThrow(
			expect.objectContaining({ category: "internal", code: "stream.session_released" }),
		);
		expect(store.get("s1")?.generation).toBe(0);
		expect(store.get("s1")?.process).toBeNull();
	});

	test("detachProcess only detaches the exact handle it is given", () => {
		const store = new SessionStore();
		store.register(registration("s1"));
		const first = fakeProcess();
		store.attachProcess("s1", first, 0);
		const replacement = fakeProcess();
		store.attachProcess("s1", replacement, 60);

		store.detachProcess("s1", first);

		expect(store.get("s1")?.process).toBe(replacement);

		store.detachProcess("s1", replacement);
		expect(store.get("s1")?.process).toBeNull();
	});

	test("touch refreshes client liveness, but not for ending sessions", () => {
		dateStub = stubMethod(Date, "now", () => 42_000);
		const store = new SessionStore();
		const session = store.register(registration("s1"));
		session.lastActivity = 0;

		store.touch("s1");
		expect(session.lastActivity).toBe(42_000);

		store.claimRelease("s1");
		session.lastActivity = 0;

		store.touch("s1");
		expect(session.lastActivity).toBe(0);
	});

	test("claimRelease allows creating and active sessions and refuses ending and unknown ones", () => {
		const store = new SessionStore();
		store.register(registration("creating"));
		store.register(registration("active"));
		store.attachProcess("active", fakeProcess(), 0);

		expect(store.claimRelease("creating")).toBe(true);
		expect(store.claimRelease("active")).toBe(true);
		expect(store.claimRelease("creating")).toBe(false);
		expect(store.claimRelease("active")).toBe(false);
		expect(store.claimRelease("ghost")).toBe(false);
	});
});

describe("session store: access to ending sessions", () => {
	test("getSessionAccess hides ending sessions", () => {
		const store = new SessionStore();
		store.register(registration("s1"));

		expect(store.getSessionAccess("s1")).toEqual({ mediaFileId: "file-s1", profileId: "profile-1" });

		store.claimRelease("s1");
		expect(store.getSessionAccess("s1")).toBeUndefined();
	});

	test("isSessionActive requires an attached process", () => {
		const store = new SessionStore();
		store.register(registration("s1"));
		expect(store.isSessionActive("s1")).toBe(false);

		store.attachProcess("s1", fakeProcess(), 0);
		expect(store.isSessionActive("s1")).toBe(true);
	});

	test("findStaleReservations reports only creating entries past the deadline", () => {
		const store = new SessionStore();
		store.register(registration("stuck"));
		store.register(registration("running"));
		store.attachProcess("running", fakeProcess(), 0);

		const now = Date.now() + 61_000;
		expect(store.findStaleReservations(now)).toEqual(["stuck"]);
		expect(store.findStaleReservations(Date.now())).toEqual([]);
	});

	test("terminated history powers the profile cooldown and is cleaned up by age", () => {
		let now = 1_000_000;
		dateStub = stubMethod(Date, "now", () => now);
		const store = new SessionStore();
		store.register(registration("s1"));
		store.claimRelease("s1");
		store.storeTerminated("s1", { mediaFileId: "file-s1", profileId: "profile-1" }, "admin-stop");

		expect(store.getTerminatedSession("s1")?.reason).toBe("admin-stop");
		expect(store.isProfileTerminatedRecently("profile-1", "file-s1", 1_000)).toEqual({ reason: "admin-stop" });
		expect(store.isProfileTerminatedRecently("profile-1", "other", 1_000)).toBeNull();

		// Right after termination the entry is inside the 5 s window and survives cleanup.
		store.cleanupTerminatedSessions(5_000);
		expect(store.getTerminatedSession("s1")?.reason).toBe("admin-stop");

		// Ten seconds later it is outside the window, so cleanup removes it.
		now += 10_000;
		store.cleanupTerminatedSessions(5_000);
		expect(store.getTerminatedSession("s1")).toBeUndefined();
		expect(store.isProfileTerminatedRecently("profile-1", "file-s1", 1_000)).toBeNull();
	});

	test("terminated history bounds capacity and evicts oldest entries FIFO", () => {
		const store = new SessionStore();
		for (let i = 0; i < 1_005; i++) {
			store.storeTerminated(`session-${i}`, { mediaFileId: `file-${i}`, profileId: `profile-${i}` }, "timeout");
		}

		// First 5 sessions must be evicted by FIFO bound (1_000 cap)
		expect(store.getTerminatedSession("session-0")).toBeUndefined();
		expect(store.getTerminatedSession("session-4")).toBeUndefined();
		expect(store.getTerminatedSession("session-5")?.reason).toBe("timeout");
		expect(store.isProfileTerminatedRecently("profile-0", "file-0", 60_000)).toBeNull();
		expect(store.isProfileTerminatedRecently("profile-1004", "file-1004", 60_000)).toEqual({ reason: "timeout" });
	});

	test("recordPlayedPosition counts only media time that moved while playing, within the wall-clock time", () => {
		const store = new SessionStore();
		store.register(registration("s1"));

		store.recordPlayedPosition("s1", 10, false, 1_000);
		store.recordPlayedPosition("s1", 25, false, 16_000);
		// A paused heartbeat: the position does not move.
		store.recordPlayedPosition("s1", 25, true, 26_000);
		// A forward seek counts at most the 10 wall-clock seconds since the last heartbeat.
		store.recordPlayedPosition("s1", 300, false, 36_000);
		// A backward seek counts nothing.
		store.recordPlayedPosition("s1", 120, false, 46_000);
		// A seek made while paused counts nothing, but its position is still the furthest reached.
		store.recordPlayedPosition("s1", 900, true, 56_000);

		expect(store.playbackOf("s1")).toEqual({ playedSeconds: 25, furthestPosition: 900 });
		expect(store.playbackOf("unknown")).toEqual({ playedSeconds: 0, furthestPosition: 0 });
	});
});
