import { describe, expect, test } from "bun:test";
import { canReserveStreamingSession } from "@/modules/streaming/runtime/sessions/session-capacity";

describe("streaming session capacity", () => {
	test("rejects a new stream once active and queued sessions reach the limit", () => {
		expect(canReserveStreamingSession({ activeSessions: 2, reservedSessions: 1, maxSessions: 3, alreadyAllocated: false })).toBeFalse();
	});

	test("allows an existing stream to be reconfigured at the limit", () => {
		expect(canReserveStreamingSession({ activeSessions: 3, reservedSessions: 0, maxSessions: 3, alreadyAllocated: true })).toBeTrue();
	});

	test("rejects when a single user exceeds their per-user session cap", () => {
		expect(
			canReserveStreamingSession({
				activeSessions: 1,
				reservedSessions: 0,
				maxSessions: 10,
				activeUserSessions: 2,
				reservedUserSessions: 0,
				maxSessionsPerUser: 2,
				alreadyAllocated: false,
			}),
		).toBeFalse();
	});

	test("allows when user is within per-user limit", () => {
		expect(
			canReserveStreamingSession({
				activeSessions: 1,
				reservedSessions: 0,
				maxSessions: 10,
				activeUserSessions: 1,
				reservedUserSessions: 0,
				maxSessionsPerUser: 2,
				alreadyAllocated: false,
			}),
		).toBeTrue();
	});
});
