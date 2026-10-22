import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@/config/env.config";
import { hashProfilePin } from "@/utils/crypto.utils";
import { verifyProfileUnlock } from "@/utils/profile-unlock.utils";
import { insertProfiles, insertUsers, type ProfileInsert, type ProfileRow, selectProfiles } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { clearWrongPins } from "./profile-pin-attempts.limiter";
import { profilesService } from "./profiles.service";

// Profiles are real rows. The PIN attempt counter is process-wide, so the key these tests use is cleared after each one.
const db = useTestDatabase();
const KIDS_ATTEMPT_KEY = "user-1:profile-kids";

async function seedAccounts(): Promise<void> {
	await insertUsers(db.client(), [
		{ id: "user-1", name: "Owner", email: "owner@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
}

async function seedProfile(row: ProfileInsert): Promise<void> {
	await insertProfiles(db.client(), row);
}

async function storedProfile(id: string): Promise<ProfileRow | undefined> {
	const row = (await selectProfiles(db.client())).find((item) => item.id === id);

	return row;
}

async function kidsPinHash(): Promise<string | null> {
	return (await hashProfilePin("2468")) ?? null;
}

beforeEach(async () => {
	await seedAccounts();
});

afterEach(() => {
	clearWrongPins(KIDS_ATTEMPT_KEY);
});

describe("profilesService.hasPin", () => {
	test("refuses to say whether another account's profile has a PIN", async () => {
		await seedProfile({ id: "profile-other", userId: "user-2", name: "NotMine" });

		await expect(profilesService.hasPin("profile-other", "user-1")).rejects.toMatchObject({
			category: "forbidden",
			code: "profile.not_owned",
		});
	});
});

describe("profilesService.switch", () => {
	test("answers with profile.pin_invalid (403) — not a 404 — when a PIN-protected profile is opened without a PIN", async () => {
		await seedProfile({ id: "profile-kids", userId: "user-1", name: "Kids", pin: await kidsPinHash() });

		await expect(profilesService.switch({ profileId: "profile-kids" }, "user-1")).rejects.toMatchObject({
			category: "forbidden",
			code: "profile.pin_invalid",
		});
	});

	test("rejects a wrong PIN with profile.pin_invalid and reports the attempts left", async () => {
		await seedProfile({ id: "profile-kids", userId: "user-1", name: "Kids", pin: await kidsPinHash() });

		await expect(profilesService.switch({ profileId: "profile-kids", pin: "0000" }, "user-1")).rejects.toMatchObject({
			category: "forbidden",
			code: "profile.pin_invalid",
			params: { attemptsRemaining: 9 },
		});
	});

	test("a correct PIN opens the PIN-protected profile and returns an unlock token", async () => {
		await seedProfile({ id: "profile-kids", userId: "user-1", name: "Kids", pin: await kidsPinHash() });

		const opened = await profilesService.switch({ profileId: "profile-kids", pin: "2468" }, "user-1");

		expect(opened).toMatchObject({ success: true, profileId: "profile-kids" });
		expect(verifyProfileUnlock(opened.unlockToken ?? undefined, env.BETTER_AUTH_SECRET)).toMatchObject({ profileId: "profile-kids" });
	});

	test("refuses a profile that belongs to another account", async () => {
		await seedProfile({ id: "profile-other", userId: "user-2", name: "NotMine" });

		await expect(profilesService.switch({ profileId: "profile-other" }, "user-1")).rejects.toMatchObject({
			category: "forbidden",
			code: "profile.not_owned",
		});
	});
});

describe("profilesService.update", () => {
	test("answers profile.name_conflict when renaming onto a sibling's name", async () => {
		await seedProfile({ id: "profile-1", userId: "user-1", name: "Alex" });
		await seedProfile({ id: "profile-2", userId: "user-1", name: "Kids" });

		await expect(profilesService.update("profile-1", { name: "Kids" }, undefined, "user-1")).rejects.toMatchObject({
			category: "conflict",
			code: "profile.name_conflict",
		});
		expect((await storedProfile("profile-1"))?.name).toBe("Alex");
	});

	test("removes the PIN and the avatar when they are sent as null", async () => {
		await seedProfile({ id: "profile-1", userId: "user-1", name: "Alex", pin: await kidsPinHash(), avatarUrl: "/v1/images/old.png" });

		await profilesService.update("profile-1", { pin: null, avatarUrl: null }, undefined, "user-1");

		expect(await storedProfile("profile-1")).toMatchObject({ pin: null, avatarUrl: null });
	});

	test("keeps the PIN and the avatar when an update leaves them out", async () => {
		const pin = await kidsPinHash();
		await seedProfile({ id: "profile-1", userId: "user-1", name: "Alex", pin, avatarUrl: "/v1/images/old.png" });

		await profilesService.update("profile-1", { name: "Renamed" }, undefined, "user-1");

		expect(await storedProfile("profile-1")).toMatchObject({ name: "Renamed", pin, avatarUrl: "/v1/images/old.png" });
	});
});
