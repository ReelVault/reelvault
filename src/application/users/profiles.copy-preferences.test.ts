import { afterEach, expect, test } from "bun:test";
import { profilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { DomainError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { profilesService } from "./profiles.service";

const stubs: Array<{ restore(): void }> = [];
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

test("copying preferences needs both profiles to belong to the caller, then copies the source's overrides onto the target", async () => {
	const owned = new Set(["mine-1", "mine-2"]);
	const assertOwned = stubMethod(profilesService, "assertOwnedProfile", (profileId: string) =>
		owned.has(profileId)
			? Promise.resolve()
			: Promise.reject(new DomainError("forbidden", "Profile belongs to another account", { code: "profile.forbidden" })),
	);
	const copy = stubMethod(profilePreferencesRepository, "copyFrom", () => Promise.resolve({ profileId: "mine-1" }));
	stubs.push(assertOwned, copy);

	await profilesService.copyPreferences("mine-1", "mine-2", "user-1");

	expect(copy.calls).toEqual([[{ sourceProfileId: "mine-2", targetProfileId: "mine-1" }]]);

	await expect(profilesService.copyPreferences("mine-1", "someone-else", "user-1")).rejects.toMatchObject({ category: "forbidden" });
	expect(copy.calls).toHaveLength(1);
});
