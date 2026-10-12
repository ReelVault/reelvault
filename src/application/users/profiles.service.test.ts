import { afterEach, describe, expect, test } from "bun:test";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { hashProfilePin } from "@/utils/crypto.utils";
import type { DomainError } from "@/utils/errors";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub";
import { profilesService } from "./profiles.service";

process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-32-characters";

const originalFindByPrimaryId = profilesRepository.findByPrimaryId;

/** Minimal row shape consumed by `switch`; the repository returns full rows. */
function fakeProfile(row: { id: string; userId: string; name: string; pin: string | null }): typeof profilesRepository.findByPrimaryId {
	return (async () => row) as unknown as typeof profilesRepository.findByPrimaryId;
}

afterEach(() => {
	profilesRepository.findByPrimaryId = originalFindByPrimaryId;
});

describe("profilesService.hasPin", () => {
	test("reports whether the owned profile is PIN-protected", async () => {
		const lookup = stubMethod(profilesRepository, "findByPrimaryId", () =>
			Promise.resolve({ id: "profile-pin", userId: "user-pin", pin: hashProfilePin("1234") }),
		);
		try {
			expect(await profilesService.hasPin("profile-pin", "user-pin")).toEqual({ hasPin: true });
		} finally {
			lookup.restore();
		}
	});

	test("reports no PIN for a profile without one", async () => {
		const lookup = stubMethod(profilesRepository, "findByPrimaryId", () =>
			Promise.resolve({ id: "profile-open", userId: "user-open", pin: null }),
		);
		try {
			expect(await profilesService.hasPin("profile-open", "user-open")).toEqual({ hasPin: false });
		} finally {
			lookup.restore();
		}
	});

	test("refuses to say whether another account's profile has a PIN", async () => {
		const lookup = stubMethod(profilesRepository, "findByPrimaryId", () =>
			Promise.resolve({ id: "profile-other", userId: "someone-else", pin: null }),
		);
		try {
			await expect(profilesService.hasPin("profile-other", "user-pin")).rejects.toMatchObject({
				code: "profile.not_owned",
				category: "forbidden",
			});
		} finally {
			lookup.restore();
		}
	});
});

describe("profilesService.switch", () => {
	test("answers with profile.pin_invalid (403) — not a 404 — when a PIN-protected profile is opened without a PIN", async () => {
		profilesRepository.findByPrimaryId = fakeProfile({
			id: "profile-kids",
			userId: "user-1",
			name: "Kids",
			pin: (await hashProfilePin("2468")) ?? null,
		});

		let caught: unknown;
		try {
			await profilesService.switch({ profileId: "profile-kids" }, "user-1");
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ category: "forbidden" });
		expect((caught as DomainError).code).toBe("profile.pin_invalid");
	});

	test("rejects a wrong PIN with profile.pin_invalid", async () => {
		profilesRepository.findByPrimaryId = fakeProfile({
			id: "profile-kids",
			userId: "user-1",
			name: "Kids",
			pin: (await hashProfilePin("2468")) ?? null,
		});

		let caught: unknown;
		try {
			await profilesService.switch({ profileId: "profile-kids", pin: "0000" }, "user-1");
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ category: "forbidden" });
		expect((caught as DomainError).code).toBe("profile.pin_invalid");
	});

	test("switches freely into a profile without a PIN", async () => {
		profilesRepository.findByPrimaryId = fakeProfile({
			id: "profile-open",
			userId: "user-1",
			name: "Alex",
			pin: null,
		});

		const result = await profilesService.switch({ profileId: "profile-open" }, "user-1");

		expect(result.success).toBe(true);
		expect(result.profileId).toBe("profile-open");
		expect(result.unlockToken).toBeNull();
	});

	test("refuses a profile that belongs to another account", async () => {
		profilesRepository.findByPrimaryId = fakeProfile({
			id: "profile-other",
			userId: "user-2",
			name: "NotMine",
			pin: null,
		});

		let caught: unknown;
		try {
			await profilesService.switch({ profileId: "profile-other" }, "user-1");
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ category: "forbidden" });
		expect((caught as DomainError).code).toBe("profile.not_owned");
	});
});

describe("profilesService.update", () => {
	const activeStubs: MethodStub[] = [];

	afterEach(() => {
		for (const stub of activeStubs.toReversed()) stub.restore();
		activeStubs.length = 0;
	});

	test("answers profile.name_conflict when renaming onto a sibling's name", async () => {
		activeStubs.push(
			stubMethod(profilesRepository, "findByPrimaryId", async () => ({ id: "profile-1", userId: "user-1", name: "Alex", pin: null })),
			stubMethod(profilesRepository, "isNameTaken", async () => true),
		);

		let caught: unknown;
		try {
			await profilesService.update("profile-1", { name: "Kids" }, undefined, "user-1");
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ category: "conflict" });
		expect((caught as DomainError).code).toBe("profile.name_conflict");
	});

	test("renames freely when the name is free, excluding the profile itself", async () => {
		activeStubs.push(
			stubMethod(profilesRepository, "findByPrimaryId", async () => ({ id: "profile-1", userId: "user-1", name: "Alex", pin: null })),
			stubMethod(profilesRepository, "isNameTaken", async () => false),
			stubMethod(profilesRepository, "updateAndRead", async () => ({ id: "profile-1", userId: "user-1", name: "New", pin: null })),
		);

		const result = await profilesService.update("profile-1", { name: "New" }, undefined, "user-1");

		expect(result.name).toBe("New");
		expect(activeStubs[1]?.calls[0]?.[0]).toEqual({ userId: "user-1", name: "New", excludeId: "profile-1" });
	});

	test("removes the PIN and the avatar when they are sent as null, and keeps them when omitted", async () => {
		const updateStub = stubMethod(profilesRepository, "updateAndRead", async () => ({
			id: "profile-1",
			userId: "user-1",
			name: "Alex",
			pin: null,
		}));
		activeStubs.push(
			stubMethod(profilesRepository, "findByPrimaryId", async () => ({
				id: "profile-1",
				userId: "user-1",
				name: "Alex",
				pin: "stored-hash",
			})),
			updateStub,
		);

		await profilesService.update("profile-1", { pin: null, avatarUrl: null }, undefined, "user-1");
		await profilesService.update("profile-1", { name: "Alex" }, undefined, "user-1");

		const [removal, untouched] = updateStub.calls.map((call) => call[1]);
		expect(removal).toMatchObject({ pin: null, avatarUrl: null });
		expect(untouched).not.toHaveProperty("pin", null);
		expect(untouched).toMatchObject({ pin: undefined });
	});
});
