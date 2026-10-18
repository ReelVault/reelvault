import { describe, expect, test } from "bun:test";
import { searchWithVariants } from "./query-variants.service";

const LONG_TITLE = "Obscure Movie: A Long Subtitle";

describe("searchWithVariants", () => {
	test("keeps the first occurrence of a result that a later variant returns again", async () => {
		const queries: string[] = [];
		const result = await searchWithVariants(
			(query) => {
				queries.push(query);
				// The first phrasing finds a non-matching title; a later one returns the same id again, plus a new one.
				return Promise.resolve(
					queries.length === 1
						? [{ externalId: "id-1", title: "Unrelated Film" }]
						: [
								{ externalId: "id-1", title: LONG_TITLE },
								{ externalId: "id-2", title: "Obscure Movie II" },
							],
				);
			},
			LONG_TITLE,
			undefined,
		);

		expect(queries.length).toBeGreaterThanOrEqual(2);
		expect(result).toEqual([
			{ externalId: "id-1", title: "Unrelated Film" },
			{ externalId: "id-2", title: "Obscure Movie II" },
		]);
	});

	test("stops querying variants once a confident match is found", async () => {
		const queries: string[] = [];
		await searchWithVariants(
			(query) => {
				queries.push(query);

				return Promise.resolve([
					{ externalId: "id-1", title: LONG_TITLE, originalTitle: LONG_TITLE, releaseDate: "2001-01-01", popularity: 10, voteCount: 100 },
				]);
			},
			LONG_TITLE,
			2001,
		);

		// An exact title and year reach the stop score, so only the first of the several phrasings is queried.
		expect(queries).toEqual([LONG_TITLE]);
	});

	test("continues to the next variant when the first yields nothing", async () => {
		let calls = 0;
		const result = await searchWithVariants(
			() => {
				calls++;

				return Promise.resolve(calls === 1 ? [] : [{ externalId: "late-1", title: LONG_TITLE }]);
			},
			LONG_TITLE,
			undefined,
		);

		expect(calls).toBeGreaterThanOrEqual(2);
		expect(result).toEqual([{ externalId: "late-1", title: LONG_TITLE }]);
	});
});
