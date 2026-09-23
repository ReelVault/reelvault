import { describe, expect, test } from "bun:test";
import { defineFields, type RequireFields } from "@sdk/common/fields";
import type { LibraryWithRelations } from "@sdk/common/library.types";

const libraryFields = defineFields<LibraryWithRelations>()("id", "type", "name", "paths.id", "paths.path");
type LibraryProjection = RequireFields<LibraryWithRelations, typeof libraryFields>;

describe("SDK field builder", () => {
	test("serializes readable field definitions into the API format", () => {
		expect(libraryFields).toBe("id,type,name,paths.id,paths.path");
	});

	test("projection type requires every listed field at compile time", () => {
		const library: LibraryProjection = {
			id: "library-1",
			type: "movies",
			name: "Movies",
			paths: [{ id: "path-1", path: "/media/movies" }],
		};

		expect(library.id).toBe("library-1");
	});
});
