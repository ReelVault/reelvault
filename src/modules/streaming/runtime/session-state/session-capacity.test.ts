import { describe, expect, test } from "bun:test";
import { canReserveStreamingSession } from "@/modules/streaming/runtime/session-state/session-capacity.policy";

describe("streaming session capacity", () => {
	test("rejects a new stream once active and queued sessions reach the limit", () => {
		expect(canReserveStreamingSession({ activeSessions: 2, reservedSessions: 1, maxSessions: 3, alreadyAllocated: false })).toBeFalse();
	});

	test("allows an existing stream to be reconfigured at the limit", () => {
		expect(canReserveStreamingSession({ activeSessions: 3, reservedSessions: 0, maxSessions: 3, alreadyAllocated: true })).toBeTrue();
	});

	test.each([
		{ activeUserSessions: 2, expected: false },
		{ activeUserSessions: 1, expected: true },
	])(
		"admits a new stream only while the user is below the per-user cap (activeUserSessions $activeUserSessions)",
		({ activeUserSessions, expected }) => {
			expect(
				canReserveStreamingSession({
					activeSessions: 1,
					reservedSessions: 0,
					maxSessions: 10,
					activeUserSessions,
					reservedUserSessions: 0,
					maxSessionsPerUser: 2,
					alreadyAllocated: false,
				}),
			).toBe(expected);
		},
	);
});
