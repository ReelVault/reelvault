import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { ProfilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { schema } from "@/database/schema";

const client = databaseFactory.getClient();

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS profile_preferences_overrides (
				profile_id TEXT NOT NULL,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				CONSTRAINT profile_preferences_overrides_pk PRIMARY KEY (profile_id, key)
			)
		`),
	);
});

beforeEach(async () => {
	await client.delete(schema.profilePreferenceOverrides);
});

function createRepository(): ProfilePreferencesRepository {
	return new ProfilePreferencesRepository(databaseFactory);
}

describe("profilePreferencesRepository", () => {
	test("getEffective returns the admin defaults when the profile has no overrides", async () => {
		const repository = createRepository();
		const preferences = await repository.getEffective({ profileId: "p-defaults" });

		expect(preferences.profileId).toBe("p-defaults");
		expect(preferences.language).toBe("en");
		expect(preferences.theme).toBe("system");
		expect(preferences.autoplay).toBe(false);
		expect(preferences.subtitlesEnabled).toBe(true);
		expect(preferences.audioLanguage).toBeNull();
		expect(preferences.continueWatchingMinutes).toBe(2);
		expect(preferences.subtitleSize).toBe("normal");
	});

	test("applyUpdate stores only values that differ from the defaults", async () => {
		const repository = createRepository();
		const preferences = await repository.applyUpdate({
			profileId: "p-sparse",
			body: { autoplay: true, subtitleSize: "large" },
		});

		expect(preferences.autoplay).toBe(true);
		expect(preferences.subtitleSize).toBe("large");
		expect(await repository.listByProfileId({ profileId: "p-sparse" })).toEqual({ autoplay: "true", subtitleSize: "large" });
	});

	test("applyUpdate prunes overrides that fall back to the defaults again", async () => {
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-prune", body: { autoplay: true, subtitlesEnabled: false } });
		await repository.applyUpdate({ profileId: "p-prune", body: { autoplay: false } });

		expect(await repository.listByProfileId({ profileId: "p-prune" })).toEqual({ subtitlesEnabled: "false" });

		const preferences = await repository.getEffective({ profileId: "p-prune" });
		expect(preferences.autoplay).toBe(false);
	});

	test("applyUpdate clears languages to null without storing an override", async () => {
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-lang", body: { audioLanguage: "pl" } });

		const withLanguage = await repository.getEffective({ profileId: "p-lang" });
		expect(withLanguage.audioLanguage).toBe("pl");

		const cleared = await repository.applyUpdate({ profileId: "p-lang", body: { audioLanguage: "" } });
		expect(cleared.audioLanguage).toBeNull();
		expect(await repository.listByProfileId({ profileId: "p-lang" })).toEqual({});
	});

	test("reset removes every stored override", async () => {
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-reset", body: { autoplay: true, subtitleColor: "cyan" } });

		const preferences = await repository.reset({ profileId: "p-reset" });

		expect(preferences.autoplay).toBe(false);
		expect(preferences.subtitleColor).toBe("white");
		expect(await repository.listByProfileId({ profileId: "p-reset" })).toEqual({});
	});

	test("getEffective falls back to the default for corrupt stored values", async () => {
		const repository = createRepository();
		await client.insert(schema.profilePreferenceOverrides).values({ profileId: "p-corrupt", key: "subtitleSize", value: "gigantic" });

		const preferences = await repository.getEffective({ profileId: "p-corrupt" });

		expect(preferences.subtitleSize).toBe("normal");
	});

	test("applyUpdate ignores keys outside the preference registry", async () => {
		const repository = createRepository();
		const body = { autoplay: true, rogueKey: "x" };

		const preferences = await repository.applyUpdate({ profileId: "p-rogue", body });

		expect(preferences.autoplay).toBe(true);
		expect(await repository.listByProfileId({ profileId: "p-rogue" })).toEqual({ autoplay: "true" });
	});
});
