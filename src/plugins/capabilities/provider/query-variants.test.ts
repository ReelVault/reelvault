import { describe, expect, test } from "bun:test";
import { searchWithVariants } from "./query-variants";

describe("searchWithVariants", () => {
	test("merges variant results by externalId and keeps the first occurrence", async () => {
		const queries: string[] = [];
		const result = await searchWithVariants(
			(query) => {
				queries.push(query);

				return Promise.resolve([
					{ externalId: "id-1", title: "Same Movie" },
					{ externalId: "id-2", title: "Same Movie II" },
				]);
			},
			"Same Movie",
			2020,
		);

		expect(queries).toHaveLength(1);
		expect(result.map((item) => item.externalId)).toEqual(["id-1", "id-2"]);
	});

	test("stops querying variants once a confident match is found", async () => {
		const queries: string[] = [];
		await searchWithVariants(
			(query) => {
				queries.push(query);

				return Promise.resolve([{ externalId: "id-1", title: "Exact Movie", originalTitle: "Exact Movie" }]);
			},
			"Exact Movie",
			undefined,
		);

		expect(queries.length).toBeLessThan(3);
	});

	test("continues to the next variant when the first yields nothing", async () => {
		let calls = 0;
		const result = await searchWithVariants(
			() => {
				calls++;

				return Promise.resolve(calls === 1 ? [] : [{ externalId: "late-1", title: "Obscure Movie: A Long Subtitle" }]);
			},
			"Obscure Movie: A Long Subtitle",
			undefined,
		);

		expect(calls).toBeGreaterThanOrEqual(2);
		expect(result).toHaveLength(1);
	});
});
