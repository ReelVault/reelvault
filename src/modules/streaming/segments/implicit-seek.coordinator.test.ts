import { describe, expect, test } from "bun:test";
import { ImplicitSeekCoordinator } from "./implicit-seek.coordinator";

// Coordinator compares against Date.now()-scale epochs — the fake clock does the same.
const T0 = 1_700_000_000_000;

describe("implicit seek coordinator", () => {
	test("allows one trigger and blocks subsequent ones within the cooldown", () => {
		let now = T0;
		const coordinator = new ImplicitSeekCoordinator({ now: () => now });

		expect(coordinator.tryBegin("session-1")).toBe(true);
		now = T0 + 5_000;
		expect(coordinator.tryBegin("session-1")).toBe(false);
		now = T0 + 11_000;
		expect(coordinator.tryBegin("session-1")).toBe(true);
	});

	test("tracks cooldown per session", () => {
		let now = T0;
		const coordinator = new ImplicitSeekCoordinator({ now: () => now });

		expect(coordinator.tryBegin("session-1")).toBe(true);
		expect(coordinator.tryBegin("session-2")).toBe(true);
		now = T0 + 2_000;
		expect(coordinator.tryBegin("session-1")).toBe(false);
		expect(coordinator.tryBegin("session-2")).toBe(false);
	});

	test("invalidate clears the cooldown for the session", () => {
		let now = T0;
		const coordinator = new ImplicitSeekCoordinator({ now: () => now });

		expect(coordinator.tryBegin("session-1")).toBe(true);
		now = T0 + 2_000;
		coordinator.invalidate("session-1");
		expect(coordinator.tryBegin("session-1")).toBe(true);
	});

	test("announceSeeked delivers the seeked event to the session", () => {
		const deliveries: Array<{ sessionId: string; event: string; payload: unknown }> = [];
		const coordinator = new ImplicitSeekCoordinator({
			sendToSession: (sessionId, event, payload) => deliveries.push({ sessionId, event, payload }),
		});

		coordinator.announceSeeked({ sessionId: "session-1", startTime: 12.5, position: 12.5 });

		expect(deliveries).toEqual([
			{
				sessionId: "session-1",
				event: "playback:session:seeked",
				payload: { sessionId: "session-1", startTime: 12.5, position: 12.5 },
			},
		]);
	});
});
