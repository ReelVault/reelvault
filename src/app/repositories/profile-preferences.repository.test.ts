import { beforeEach, describe, expect, test } from "bun:test";
import { ProfilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

useTestDatabase();

beforeEach(async () => {
	await databaseFactory
		.getClient()
		.insert(schema.users)
		.values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
});

async function seedProfile(profileId: string): Promise<void> {
	await databaseFactory.getClient().insert(schema.profiles).values({ id: profileId, userId: "user-1", name: profileId });
}

function createRepository(): ProfilePreferencesRepository {
	return new ProfilePreferencesRepository(databaseFactory);
}

describe("profilePreferencesRepository", () => {
	test("applyUpdate stores only values that differ from the defaults", async () => {
		await seedProfile("p-sparse");
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
		await seedProfile("p-prune");
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-prune", body: { autoplay: true, subtitlesEnabled: false } });
		await repository.applyUpdate({ profileId: "p-prune", body: { autoplay: false } });

		expect(await repository.listByProfileId({ profileId: "p-prune" })).toEqual({ subtitlesEnabled: "false" });

		const preferences = await repository.getEffective({ profileId: "p-prune" });
		expect(preferences.autoplay).toBe(false);
	});

	test("applyUpdate clears languages to null without storing an override", async () => {
		await seedProfile("p-lang");
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-lang", body: { audioLanguage: "pl" } });

		const withLanguage = await repository.getEffective({ profileId: "p-lang" });
		expect(withLanguage.audioLanguage).toBe("pl");

		const cleared = await repository.applyUpdate({ profileId: "p-lang", body: { audioLanguage: "" } });
		expect(cleared.audioLanguage).toBeNull();
		expect(await repository.listByProfileId({ profileId: "p-lang" })).toEqual({});
	});

	test("reset removes every stored override", async () => {
		await seedProfile("p-reset");
		const repository = createRepository();
		await repository.applyUpdate({ profileId: "p-reset", body: { autoplay: true, subtitleColor: "cyan" } });

		const preferences = await repository.reset({ profileId: "p-reset" });

		expect(preferences.autoplay).toBe(false);
		expect(preferences.subtitleColor).toBe("white");
		expect(await repository.listByProfileId({ profileId: "p-reset" })).toEqual({});
	});

	test("getEffective falls back to the default for corrupt stored values", async () => {
		await seedProfile("p-corrupt");
		const repository = createRepository();
		await databaseFactory
			.getClient()
			.insert(schema.profilePreferenceOverrides)
			.values({ profileId: "p-corrupt", key: "subtitleSize", value: "gigantic" });

		const preferences = await repository.getEffective({ profileId: "p-corrupt" });

		expect(preferences.subtitleSize).toBe("normal");
	});

	test("applyUpdate ignores keys outside the preference registry", async () => {
		await seedProfile("p-rogue");
		const repository = createRepository();
		const body = { autoplay: true, rogueKey: "x" };

		const preferences = await repository.applyUpdate({ profileId: "p-rogue", body });

		expect(preferences.autoplay).toBe(true);
		expect(await repository.listByProfileId({ profileId: "p-rogue" })).toEqual({ autoplay: "true" });
	});
});
