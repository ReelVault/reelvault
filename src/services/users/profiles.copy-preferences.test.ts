import { describe, expect, test } from "bun:test";
import {
	insertProfilePreferenceOverrides,
	insertProfiles,
	insertUsers,
	selectProfilePreferenceOverrides,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { profilesService } from "./profiles.service";

// Profiles and their preference overrides are real rows. Ownership is decided by the stored profile rows.
const db = useTestDatabase();

async function seedProfiles(): Promise<void> {
	const client = db.client();
	await insertUsers(client, [
		{ id: "user-1", name: "Owner", email: "owner@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
	await insertProfiles(client, [
		{ id: "mine-1", userId: "user-1", name: "Mine one" },
		{ id: "mine-2", userId: "user-1", name: "Mine two" },
		{ id: "someone-else", userId: "user-2", name: "Theirs" },
	]);
	await insertProfilePreferenceOverrides(client, [
		{ profileId: "mine-1", key: "theme", value: "dark" },
		{ profileId: "mine-1", key: "density", value: "compact" },
		{ profileId: "mine-2", key: "mutedNotificationTypes", value: "system" },
		{ profileId: "mine-2", key: "theme", value: "light" },
		{ profileId: "someone-else", key: "theme", value: "sepia" },
	]);
}

async function overridesOf(profileId: string): Promise<Array<[string, string]>> {
	const rows = await selectProfilePreferenceOverrides(db.client());

	return rows
		.filter((row) => row.profileId === profileId)
		.map((row) => [row.key, row.value] as [string, string])
		.toSorted((a, b) => a[0].localeCompare(b[0]));
}

describe("profilesService.copyPreferences", () => {
	test("replaces the target profile's overrides with the source profile's overrides", async () => {
		await seedProfiles();

		await profilesService.copyPreferences("mine-1", "mine-2", "user-1");

		// The target's own "density" override is not in the source, so the copy removes it.
		expect(await overridesOf("mine-1")).toEqual([
			["mutedNotificationTypes", "system"],
			["theme", "light"],
		]);
	});

	test("refuses when the source profile belongs to another account and changes nothing", async () => {
		await seedProfiles();

		await expect(profilesService.copyPreferences("mine-1", "someone-else", "user-1")).rejects.toMatchObject({ category: "forbidden" });

		expect(await overridesOf("mine-1")).toEqual([
			["density", "compact"],
			["theme", "dark"],
		]);
	});
});
