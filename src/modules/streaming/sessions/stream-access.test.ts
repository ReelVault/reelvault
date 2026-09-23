import { describe, expect, test } from "bun:test";
import { assertActiveStreamAccess, resolveSessionAccess } from "./stream-access";

describe("stream access guard", () => {
	test("requires a valid session and active profile before checking the media", async () => {
		const check = async () => null;
		await expect(assertActiveStreamAccess({ mediaFileId: "file", check })).rejects.toThrow("Session expired or invalid");
		await expect(assertActiveStreamAccess({ userId: "user", mediaFileId: "file", check })).rejects.toThrow("An active profile is required");
	});

	test("passes the current user and profile to the access policy", async () => {
		let received: { userId: string; profileId: string; mediaFileId: string } | undefined;
		await assertActiveStreamAccess({
			userId: "user",
			profileId: "profile",
			mediaFileId: "file",
			check: (input) => {
				received = input;

				return Promise.resolve(null);
			},
		});
		expect(received).toEqual({ userId: "user", profileId: "profile", mediaFileId: "file" });
	});
});

describe("resolveSessionAccess", () => {
	const live = { mediaFileId: "file", profileId: "profile" };

	test("returns the live session access", () => {
		expect(
			resolveSessionAccess(
				"s1",
				() => live,
				() => undefined,
			),
		).toEqual(live);
	});

	test("treats a non-admin terminated session as not found (it must not look alive)", () => {
		expect(() =>
			resolveSessionAccess(
				"s1",
				() => undefined,
				() => ({ reason: "inactivity-timeout" }),
			),
		).toThrow("Playback session not found");
	});

	test("treats an admin-terminated session as forbidden with a distinct code", () => {
		expect(() =>
			resolveSessionAccess(
				"s1",
				() => undefined,
				() => ({ reason: "admin.stop" }),
			),
		).toThrow("terminated");
	});
});
