import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTreeSync } from "@/utils/directory.utils";
import { episodesRepository } from "./episodes.repository";
import { seasonsRepository } from "./seasons.repository";

let tempDir: string;
let factory: DatabaseFactory;
const spies: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "rv-seasons-"));
	factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)));
});

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	factory.shutdown();
	removeTreeSync(tempDir);
});

/**
 * A show whose seasons are inserted newest first. Returns the metadata id and the
 * season ids keyed by season number, so expectations do not depend on the code
 * under test.
 */
async function seedShowInsertedDescending(): Promise<{ metadataId: string; seasonIds: Record<number, string> }> {
	const db = factory.getClient();
	const [show] = await db
		.insert(schema.metadata)
		.values({ stableKey: "show", title: "Show", type: "tv_show", releaseDate: "2001-01-01", overview: "Overview" })
		.returning({ id: schema.metadata.id });
	if (!show) throw new Error("metadata insert returned no row");

	const seasonIds: Record<number, string> = {};
	for (const seasonNumber of [3, 2, 1]) {
		const [season] = await db
			.insert(schema.seasons)
			.values({ stableKey: `show-season-${seasonNumber}`, metadataId: show.id, seasonNumber })
			.returning({ id: schema.seasons.id });
		if (!season) throw new Error("season insert returned no row");
		seasonIds[seasonNumber] = season.id;

		for (const episodeNumber of [2, 1]) {
			await db.insert(schema.episodes).values({
				stableKey: `show-season-${seasonNumber}-episode-${episodeNumber}`,
				seasonId: season.id,
				episodeNumber,
			});
		}
	}

	return { metadataId: show.id, seasonIds };
}

// A library scan refreshes planner statistics. Without an ORDER BY the reads below
// keep index order until those statistics exist, then can return insertion order.
describe("seasonsRepository.findByMetadataId", () => {
	test("returns seasons in season-number order once planner statistics exist", async () => {
		const { metadataId } = await seedShowInsertedDescending();
		factory.analyze();

		const seasons = await seasonsRepository.findByMetadataId(metadataId);

		expect(seasons.map((season) => season.seasonNumber)).toEqual([1, 2, 3]);
	});
});

describe("episodesRepository.findByMetadataIdProjected", () => {
	test("returns episodes ordered by season and episode number once planner statistics exist", async () => {
		const { metadataId, seasonIds } = await seedShowInsertedDescending();
		factory.analyze();

		const episodes = await episodesRepository.findByMetadataIdProjected(metadataId);
		const order = episodes.map((episode) => `${episode.seasonId}:${episode.episodeNumber}`);
		const expected = [1, 2, 3].flatMap((seasonNumber) => [`${seasonIds[seasonNumber]}:1`, `${seasonIds[seasonNumber]}:2`]);

		expect(order).toEqual(expected);
	});
});
