import { beforeEach, describe, expect, test } from "bun:test";
import { recommendationFeatureKey } from "@/utils/recommendation-feature.utils";
import { insertMetadata, insertMetadataCrew, insertPeople } from "../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import {
	clearRecommendationFeatureStats,
	findRecommendationCandidates,
	findRecommendationFeatureRows,
	findRecommendationFeatureStats,
} from "./discover-recommendations.reader";

const db = useTestDatabase();

const DIRECTOR_ID = "director-person";

/** Five shows with media, each crediting one director under a provider's own (non-English) job name. */
async function seedShows(client: ReturnType<typeof db.client>): Promise<void> {
	await insertPeople(client, { id: DIRECTOR_ID, stableKey: DIRECTOR_ID, name: "Anna Reżyser" });
	for (let index = 0; index < 5; index += 1) {
		const id = `show-${index}`;
		await insertMetadata(client, {
			id,
			stableKey: id,
			title: `Show ${index}`,
			type: "tv_show",
			releaseDate: "2020-01-01",
			latestMediaCreatedAt: new Date("2026-01-01"),
		});
		const personId = index < 2 ? DIRECTOR_ID : `director-${index}`;
		if (index >= 2) await insertPeople(client, { id: personId, stableKey: personId, name: `Director ${index}` });
		await insertMetadataCrew(client, { metadataId: id, personId, job: "Reżyseria", department: "Reżyseria" });
	}
}

beforeEach(() => {
	clearRecommendationFeatureStats();
});

describe("crew credits without assumed job names", () => {
	test("weighs a provider's own job name by how every title of the type credits it once", async () => {
		await seedShows(db.client());

		const stats = findRecommendationFeatureStats();

		expect([...(stats.roleWeights ?? [])]).toEqual([["Reżyseria", 1]]);
		expect(stats.documentFrequency.get(recommendationFeatureKey("credit", DIRECTOR_ID))).toBe(2);
	});

	test("leaves out a job that only one title in five credits", async () => {
		const client = db.client();
		await seedShows(client);
		await insertPeople(client, { id: "publicist", stableKey: "publicist", name: "Unit Publicist" });
		await insertMetadataCrew(client, { metadataId: "show-0", personId: "publicist", job: "Publicity", department: "Crew" });

		const stats = findRecommendationFeatureStats();

		expect(stats.roleWeights?.has("Publicity")).toBeFalse();
	});

	test("leaves out a job a title shares among a crowd", async () => {
		const client = db.client();
		await seedShows(client);
		for (let show = 0; show < 5; show += 1) {
			for (let person = 0; person < 10; person += 1) {
				const id = `stunt-${show}-${person}`;
				await insertPeople(client, { id, stableKey: id, name: `Stunt ${id}` });
				await insertMetadataCrew(client, { metadataId: `show-${show}`, personId: id, job: "Stunts", department: "Crew" });
			}
		}

		const stats = findRecommendationFeatureStats();

		// Every show has the job, but ten people hold it: 1 / 10.
		expect(stats.roleWeights?.has("Stunts")).toBeFalse();
	});

	test("reads a kept credit with the provider's job name as its role", async () => {
		await seedShows(db.client());

		const rows = findRecommendationFeatureRows(["show-0"], ["Reżyseria"]);

		expect(rows).toEqual([{ metadataId: "show-0", kind: "credit", id: DIRECTOR_ID, label: "Anna Reżyser", role: "Reżyseria" }]);
	});

	test("finds candidates through a shared credit in a kept job", async () => {
		await seedShows(db.client());

		const candidates = findRecommendationCandidates({
			features: [{ kind: "credit", id: DIRECTOR_ID }],
			excludeIds: ["show-0"],
			limit: 10,
			creditRoles: ["Reżyseria"],
		});

		expect(candidates.map((row) => row.id)).toEqual(["show-1"]);
	});
});
