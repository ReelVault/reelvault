import { describe, expect, test } from "bun:test";
import { insertEpisodes, insertMetadata, insertSeasons } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { DatabaseSidecarSnapshotResolver } from "./sidecar-snapshot.resolver";

const db = useTestDatabase();

function firstRow<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row;
}

describe("DatabaseSidecarSnapshotResolver", () => {
	test("resolves a stored season and episode into snapshots", async () => {
		const client = db.client();
		const metadata = firstRow(
			await insertMetadata(client, { id: "series-1", stableKey: "series-1", title: "Series", type: "tv_show", releaseDate: "2019-01-01" }),
		);
		const season = firstRow(
			await insertSeasons(client, {
				metadataId: metadata.id,
				stableKey: "season-1",
				seasonNumber: 1,
				name: "Season One",
				airDate: "2019-03-15",
				overview: "The beginning",
				status: "released",
			}),
		);
		const episode = firstRow(
			await insertEpisodes(client, {
				seasonId: season.id,
				stableKey: "episode-1",
				episodeNumber: 1,
				title: "Pilot",
				airDate: "2019-03-15",
			}),
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
