import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { filterLike, filterM2M, parseCommaSeparated } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { assertPresent } from "@/utils/domain.errors";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";

const { client } = useTestDatabase();

describe("QueryFiltering", () => {
	test("a filter with more values than the limit answers the too-many-values code with the limit", () => {
		const ids = Array.from({ length: 501 }, (_, index) => `id-${index}`);
		let caught: unknown;
		try {
			filterM2M(schema.genres.id, ids, schema.genres, schema.genres.id, schema.genres.id);
		} catch (error) {
			caught = error;
		}

		expect(caught).toMatchObject({ code: "validation.filter_too_many_values", params: { max: 500 } });
	});

	test("bounds comma-separated filter values", () => {
		expect(() => parseCommaSeparated(Array.from({ length: 501 }, (_, index) => `id-${index}`).join(","))).toThrow(
			expect.objectContaining({ category: "validation", code: "validation.filter_too_many_values" }),
		);
	});

	test("m2m keeps only the metadata linked to one of the listed ids", async () => {
		const db = client();
		const genreIds: string[] = [];
		for (const name of ["Drama", "Comedy", "Horror"]) {
			const [genre] = await db.insert(schema.genres).values({ stableKey: name.toLowerCase(), name }).returning({ id: schema.genres.id });
			assertPresent(genre, "genre insert");
			genreIds.push(genre.id);

			const [show] = await db
				.insert(schema.metadata)
				.values({ stableKey: `show-${name.toLowerCase()}`, title: `${name} Show`, type: "movie", releaseDate: "2001-01-01" })
				.returning({ id: schema.metadata.id });
			assertPresent(show, "metadata insert");
			await db.insert(schema.metadataGenres).values({ metadataId: show.id, genreId: genre.id });
		}

		const filter = filterM2M(
			schema.metadata.id,
			genreIds.slice(0, 2),
			schema.metadataGenres,
			schema.metadataGenres.metadataId,
			schema.metadataGenres.genreId,
		);
		assertPresent(filter, "m2m filter");

		const shows = await db.select({ title: schema.metadata.title }).from(schema.metadata).where(filter).orderBy(schema.metadata.title);
		expect(shows).toEqual([{ title: "Comedy Show" }, { title: "Drama Show" }]);
	});

	test("like treats % and _ as literal text, not wildcards", async () => {
		const db = client();
		await db.insert(schema.libraries).values([
			{ id: "l-1", name: "50%", type: "movies" },
			{ id: "l-2", name: "50x", type: "movies" },
			{ id: "l-3", name: "a_b", type: "movies" },
			{ id: "l-4", name: "axb", type: "movies" },
		]);

		const percentMatches = await db
			.select({ name: schema.libraries.name })
			.from(schema.libraries)
			.where(filterLike(schema.libraries.name, "50%"));
		const underscoreMatches = await db
			.select({ name: schema.libraries.name })
			.from(schema.libraries)
			.where(filterLike(schema.libraries.name, "a_b"));

		expect(percentMatches).toEqual([{ name: "50%" }]);
		expect(underscoreMatches).toEqual([{ name: "a_b" }]);
	});
});
