import { describe, expect, test } from "bun:test";
import { metadataRepository } from "@/repositories/metadata.repository";
import { toMap } from "@/utils/array.utils";
import { insertMetadata } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { buildTrending } from "./recommendation-trending.service";

const db = useTestDatabase();

describe("buildTrending", () => {
	test("breaks an equal play count by popularity", async () => {
		await insertMetadata(db.client(), [
			{ id: "aaa-niche", stableKey: "aaa-niche", title: "aaa-niche", type: "movie", releaseDate: "2020-01-01", popularity: 40 },
			{ id: "zzz-fan", stableKey: "zzz-fan", title: "zzz-fan", type: "movie", releaseDate: "2020-01-01", popularity: 90 },
		]);
		// Popularity is normalised by the largest value in knownMap, so the items are loaded before the call.
		const known = toMap(await metadataRepository.findManyByIdsWithRelations(["aaa-niche", "zzz-fan"]), (item) => item.id);

		// The niche title comes first in the activity rows, so only the popularity term can move the fan title ahead.
		const trending = await buildTrending(
			[
				{ metadataId: "aaa-niche", playCount: 1 },
				{ metadataId: "zzz-fan", playCount: 1 },
			],
			[],
			10,
			known,
		);

		expect(trending.map((item) => item.id)).toEqual(["zzz-fan", "aaa-niche"]);
	});

	test("ranks a title it had to load by the same popularity scale as the titles it was given", async () => {
		await insertMetadata(db.client(), [
			{ id: "watched-a-lot", stableKey: "watched-a-lot", title: "watched-a-lot", type: "movie", releaseDate: "2020-01-01", popularity: 10 },
			{
				id: "barely-watched",
				stableKey: "barely-watched",
				title: "barely-watched",
				type: "movie",
				releaseDate: "2020-01-01",
				popularity: 100,
			},
		]);
		// Only the much-played title is known; the popular one is loaded inside buildTrending.
		const known = toMap(await metadataRepository.findManyByIdsWithRelations(["watched-a-lot"]), (item) => item.id);

		// 100 plays and popularity 10 score 0.64; 1 play and popularity 100 score 0.406.
		const trending = await buildTrending(
			[
				{ metadataId: "watched-a-lot", playCount: 100 },
				{ metadataId: "barely-watched", playCount: 1 },
			],
			[],
			10,
			known,
		);

		expect(trending.map((item) => item.id)).toEqual(["watched-a-lot", "barely-watched"]);
	});
});
