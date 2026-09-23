import { afterEach, describe, expect, test } from "bun:test";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { hashProfilePin } from "@/utils/crypto.utils";
import { ForbiddenError } from "@/utils/errors";
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

		expect(caught).toBeInstanceOf(ForbiddenError);
		expect((caught as ForbiddenError).code).toBe("profile.pin_invalid");
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

		expect(caught).toBeInstanceOf(ForbiddenError);
		expect((caught as ForbiddenError).code).toBe("profile.pin_invalid");
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

		expect(caught).toBeInstanceOf(ForbiddenError);
		expect((caught as ForbiddenError).code).toBe("profile.not_owned");
	});
});
