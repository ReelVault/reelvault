import { describe, expect, test } from "bun:test";
import { findSameTitleSession } from "./session-reclaim.resolver";

const titleOf = new Map([
	["file-a", "title-1"],
	["file-b", "title-1"],
	["file-c", "title-2"],
]);

describe("findSameTitleSession", () => {
	test("finds the profile's session of the title being started, whichever version it plays", () => {
		const sessions = [
			{ sessionId: "s1", mediaFileId: "file-c" },
			{ sessionId: "s2", mediaFileId: "file-b" },
		];

		expect(findSameTitleSession(sessions, titleOf, "file-a")).toEqual({ sessionId: "s2", mediaFileId: "file-b" });
	});

	test("finds nothing when the profile streams other titles only", () => {
		expect(findSameTitleSession([{ sessionId: "s1", mediaFileId: "file-c" }], titleOf, "file-a")).toBeUndefined();
	});

	test("finds nothing for a file whose title is unknown, even against a session whose title is also unknown", () => {
		expect(findSameTitleSession([{ sessionId: "s1", mediaFileId: "file-z" }], titleOf, "file-x")).toBeUndefined();
	});
});
