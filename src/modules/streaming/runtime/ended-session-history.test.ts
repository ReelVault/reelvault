import { describe, expect, test } from "bun:test";
import { ENDED_SESSION_HISTORY_LIMIT, type EndedLiveSession, EndedSessionHistory } from "./ended-session.history";

function endedSession(index: number): EndedLiveSession {
	return {
		sessionId: `session-${index}`,
		mediaFileId: "media-1",
		profileId: "profile-1",
		reason: "released",
		startedAt: index * 1000,
		endedAt: index * 1000 + 500,
	};
}

describe("EndedSessionHistory", () => {
	test("lists the newest endings first and honours the limit", () => {
		const history = new EndedSessionHistory();
		for (const index of [1, 2, 3]) history.record(endedSession(index));

		expect(history.list(2).map((session) => session.sessionId)).toEqual(["session-3", "session-2"]);
	});

	test("keeps only the newest endings once the bound is reached", () => {
		const history = new EndedSessionHistory();
		const total = ENDED_SESSION_HISTORY_LIMIT + 5;
		for (let index = 1; index <= total; index++) history.record(endedSession(index));

		const listed = history.list(ENDED_SESSION_HISTORY_LIMIT + 10);
		expect(listed).toHaveLength(ENDED_SESSION_HISTORY_LIMIT);
		expect(listed[0]?.sessionId).toBe(`session-${total}`);
		expect(listed.at(-1)?.sessionId).toBe(`session-${total - ENDED_SESSION_HISTORY_LIMIT + 1}`);
	});

	test("a non-positive limit lists nothing", () => {
		const history = new EndedSessionHistory();
		history.record(endedSession(1));

		expect(history.list(0)).toEqual([]);
		expect(history.list(-3)).toEqual([]);
	});
});
