import { expect, test } from "bun:test";
import { parseMutedNotificationTypes } from "./notification-mute.utils";

test("muted types are read from the comma-separated preference, ignoring blanks and repeats", () => {
	expect(parseMutedNotificationTypes("system, new_episode,system,")).toEqual(["system", "new_episode"]);
	expect(parseMutedNotificationTypes("")).toEqual([]);
	expect(parseMutedNotificationTypes(null)).toEqual([]);
	expect(parseMutedNotificationTypes(undefined)).toEqual([]);
});
