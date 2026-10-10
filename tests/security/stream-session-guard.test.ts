import { afterEach, describe, expect, test } from "bun:test";
import { assertSessionOwnershipById } from "@/modules/streaming/sessions/session-access.guard";
import { sessionLifecycleService } from "@/modules/streaming/sessions/session-lifecycle.service";
import { stubMethod } from "../helpers/method-stub";

/**
 * A playback session belongs to the profile that started it. The guard used by the
 * stream and playback routes must refuse any other profile, refuse unknown sessions as
 * not found, and report a session an administrator ended with its own code.
 */

const activeStubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function stubSessions(
	sessions: Record<string, { mediaFileId: string; profileId: string }>,
	terminated: Record<string, { reason: string }> = {},
) {
	activeStubs.push(
		stubMethod(sessionLifecycleService, "getSessionAccess", (sessionId: string) => sessions[sessionId]),
		stubMethod(sessionLifecycleService, "getTerminatedSession", (sessionId: string) => terminated[sessionId]),
	);
}

describe("assertSessionOwnershipById", () => {
	test("the profile that started the session gets it back", () => {
		stubSessions({ "s-1": { mediaFileId: "mf-1", profileId: "profile-a" } });

		expect(assertSessionOwnershipById("s-1", "profile-a")).toMatchObject({ mediaFileId: "mf-1", profileId: "profile-a" });
	});

	test("another profile is refused as not owned, whichever id it presents", () => {
		stubSessions({ "s-1": { mediaFileId: "mf-1", profileId: "profile-a" } });

		for (const other of ["profile-b", "", "PROFILE-A", "profile-a "]) {
			expect(() => assertSessionOwnershipById("s-1", other)).toThrow();
		}
		expect(() => assertSessionOwnershipById("s-1", "profile-b")).toThrow(expect.objectContaining({ code: "stream.session_not_owned" }));
	});

	test("a request without any profile is refused as not owned", () => {
		stubSessions({ "s-1": { mediaFileId: "mf-1", profileId: "profile-a" } });

		expect(() => assertSessionOwnershipById("s-1", undefined)).toThrow(expect.objectContaining({ code: "stream.session_not_owned" }));
	});

	test("an unknown session is refused as not found", () => {
		stubSessions({});

		let thrown: unknown;
		try {
			assertSessionOwnershipById("missing", "profile-a");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ category: "not_found" });
	});

	test("a session an administrator terminated says so with its own code", () => {
		stubSessions({}, { "s-2": { reason: "admin_terminated" } });

		expect(() => assertSessionOwnershipById("s-2", "profile-a")).toThrow(expect.objectContaining({ code: "stream.session_terminated" }));
	});
});
