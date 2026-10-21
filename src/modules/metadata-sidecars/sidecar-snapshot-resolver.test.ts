import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { DatabaseSidecarSnapshotResolver } from "@/services/catalog/metadata/sidecar-snapshot.resolver";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { episodeSnapshot, seasonSnapshot } from "./sidecar-snapshot.builder";

const db = useTestDatabase();

function firstRow<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row;
}

describe("seasonSnapshot / episodeSnapshot builders", () => {
	test("season snapshot uses the stored name and slices the year from the air date", () => {
		const snapshot = seasonSnapshot({
			name: "Season One",
			seasonNumber: 1,
			airDate: "2019-03-15",
			overview: "The beginning",
			status: "released",
		});

		expect(snapshot.title).toBe("Season One");
		expect(snapshot.releaseDate).toBe("2019-03-15");
		expect(snapshot.year).toBe(2019);
		expect(snapshot.overview).toBe("The beginning");
		expect(snapshot.status).toBe("released");
		expect(snapshot.identifiers).toEqual({});
		expect(snapshot.seasonNumber).toBe(1);
	});

	test("season snapshot falls back to `Season <n>` when the name is missing", () => {
		const snapshot = seasonSnapshot({ name: null, seasonNumber: 3, airDate: null });
		expect(snapshot.title).toBe("Season 3");
		expect(snapshot.year).toBeUndefined();
		expect(snapshot.overview).toBeUndefined();
		expect(snapshot.status).toBeUndefined();
	});

	test("episode snapshot falls back to `Episode <n>` and has no status", () => {
		const snapshot = episodeSnapshot({ title: null, episodeNumber: 7, airDate: "2020-01-02" });
		expect(snapshot.title).toBe("Episode 7");
		expect(snapshot.year).toBe(2020);
		expect(snapshot.episodeNumber).toBe(7);
		expect(snapshot.seasonNumber).toBeUndefined();

		const placed = episodeSnapshot({ title: "Pilot", seasonNumber: 2, episodeNumber: 1, airDate: null });
		expect(placed.title).toBe("Pilot");
		expect(placed.year).toBeUndefined();
		expect(placed.status).toBeUndefined();
		expect(placed.seasonNumber).toBe(2);
	});

	test("malformed dates do not produce a year", () => {
		const snapshot = seasonSnapshot({ name: "S", seasonNumber: 1, airDate: "not-a-date" });
		expect(snapshot.year).toBeUndefined();
	});
});

describe("DatabaseSidecarSnapshotResolver", () => {
	test("resolves a stored season and episode into snapshots", async () => {
		const client = db.client();
		const metadata = firstRow(
			await client
				.insert(schema.metadata)
				.values({ id: "series-1", stableKey: "series-1", title: "Series", type: "tv_show", releaseDate: "2019-01-01" })
				.returning({ id: schema.metadata.id }),
		);
		const season = firstRow(
			await client
				.insert(schema.seasons)
				.values({
					metadataId: metadata.id,
					stableKey: "season-1",
					seasonNumber: 1,
					name: "Season One",
					airDate: "2019-03-15",
					overview: "The beginning",
					status: "released",
				})
				.returning({ id: schema.seasons.id }),
		);
		const episode = firstRow(
			await client
				.insert(schema.episodes)
				.values({ seasonId: season.id, stableKey: "episode-1", episodeNumber: 1, title: "Pilot", airDate: "2019-03-15" })
				.returning({ id: schema.episodes.id }),
		);

		const resolver = new DatabaseSidecarSnapshotResolver();

		expect(await resolver.season(season.id)).toMatchObject({
			title: "Season One",
			seasonNumber: 1,
			releaseDate: "2019-03-15",
			year: 2019,
			overview: "The beginning",
			status: "released",
		});
		expect(await resolver.episode(episode.id)).toMatchObject({ title: "Pilot", episodeNumber: 1, releaseDate: "2019-03-15", year: 2019 });
	});

	test("throws not_found for metadata, season and episode ids with no row", async () => {
		const resolver = new DatabaseSidecarSnapshotResolver();

		await expect(resolver.metadata("m-404")).rejects.toMatchObject({ category: "not_found", code: "metadata.not_found" });
		await expect(resolver.season("s-404")).rejects.toMatchObject({ category: "not_found", code: "season.not_found" });
		await expect(resolver.episode("e-404")).rejects.toMatchObject({ category: "not_found", code: "episode.not_found" });
	});
});
