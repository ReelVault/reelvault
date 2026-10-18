import { afterEach, describe, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { assertSessionOwnershipById } from "@/modules/streaming/sessions/session-access.guard";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";

/**
 * A playback session belongs to the profile that started it. The guard used by the
 * stream and playback routes must refuse any other profile, refuse unknown sessions as
 * not found, and report a session an administrator ended with its own code. Sessions
 * live in the real streaming runtime; no process is started.
 */

const decision = createMockPlaybackDecision({ mode: "direct-stream", videoTranscode: false, audioTranscode: false, reason: "test" });
const openedSessionIds: string[] = [];

/** Registers a session for a fresh profile and media file, so no test shares state with another. */
function openSession(): { sessionId: string; profileId: string } {
	const sessionId = `session-${crypto.randomUUID()}`;
	const profileId = `profile-${crypto.randomUUID()}`;
	openedSessionIds.push(sessionId);
	streamingManager.registerSession(sessionId, {
		mediaFileId: `media-${crypto.randomUUID()}`,
		profileId,
		decision,
		inputPath: "/media/guard.mkv",
	});

	return { sessionId, profileId };
}

afterEach(async () => {
	await Promise.all(openedSessionIds.splice(0).map(async (sessionId) => await streamingManager.discardSession(sessionId)));
});

describe("assertSessionOwnershipById", () => {
	test("the profile that started the session gets it back", () => {
		const { sessionId, profileId } = openSession();

		expect(assertSessionOwnershipById(sessionId, profileId)).toMatchObject({ profileId });
	});

	test("another profile is refused as not owned, whichever id it presents", () => {
		const { sessionId, profileId } = openSession();

		for (const other of ["profile-b", "", profileId.toUpperCase(), `${profileId} `]) {
			expect(() => assertSessionOwnershipById(sessionId, other)).toThrow(expect.objectContaining({ code: "stream.session_not_owned" }));
		}
	});

	test("a request without any profile is refused as not owned", () => {
		const { sessionId } = openSession();

		expect(() => assertSessionOwnershipById(sessionId, undefined)).toThrow(expect.objectContaining({ code: "stream.session_not_owned" }));
	});

	test("an unknown session is refused as not found", () => {
		expect(() => assertSessionOwnershipById(`missing-${crypto.randomUUID()}`, "profile-a")).toThrow(
			expect.objectContaining({ code: "stream.session_not_found" }),
		);
	});

	test("a session that ended by client release reads as not found, not as still active", async () => {
		const { sessionId, profileId } = openSession();
		expect(await streamingManager.releaseSession(sessionId, "client-release")).toBe("released");

		expect(() => assertSessionOwnershipById(sessionId, profileId)).toThrow(expect.objectContaining({ code: "stream.session_not_found" }));
	});

	test("a session an administrator terminated says so with its own code", async () => {
		const { sessionId, profileId } = openSession();
		expect(await streamingManager.releaseSession(sessionId, "admin-terminated")).toBe("released");

		expect(() => assertSessionOwnershipById(sessionId, profileId)).toThrow(expect.objectContaining({ code: "stream.session_terminated" }));
	});
});
