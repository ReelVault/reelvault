import { describe, expect, test } from "bun:test";
import { assertActiveStreamAccess, resolveSessionAccess } from "./stream-access.guard";

describe("stream access guard", () => {
	test("requires a valid session and active profile before checking the media", async () => {
		const check = async () => null;
		await expect(assertActiveStreamAccess({ mediaFileId: "file", check })).rejects.toMatchObject({
			category: "unauthorized",
			code: "stream.session_expired",
		});
		await expect(assertActiveStreamAccess({ userId: "user", mediaFileId: "file", check })).rejects.toMatchObject({
			code: "auth.profile_required",
			category: "unauthorized",
		});
	});

	test("surfaces a policy denial as forbidden with the policy's own code", async () => {
		// The denial depends on the profile the guard forwards, so this also proves the identity reaches the policy.
		await expect(
			assertActiveStreamAccess({
				userId: "user",
				profileId: "profile",
				mediaFileId: "file",
				check: (input) =>
					Promise.resolve(
						input.profileId === "profile" ? { code: "stream.region_blocked", message: "Not available in your region" } : null,
					),
			}),
		).rejects.toMatchObject({ category: "forbidden", code: "stream.region_blocked" });
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
		).toThrow(expect.objectContaining({ category: "not_found", code: "stream.session_not_found" }));
	});

	test("treats an admin-terminated session as forbidden with a distinct code", () => {
		expect(() =>
			resolveSessionAccess(
				"s1",
				() => undefined,
				() => ({ reason: "admin-stop" }),
			),
		).toThrow(expect.objectContaining({ category: "forbidden", code: "stream.session_terminated" }));
	});
});
