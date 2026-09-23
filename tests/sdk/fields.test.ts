import { describe, expect, test } from "bun:test";
import type { SelectFields } from "@sdk/common/fields";
import type { LibraryWithRelations } from "@sdk/common/library.types";

type LibrarySummary = SelectFields<LibraryWithRelations, "id,type,name">;
type LibraryWithPaths = SelectFields<LibraryWithRelations, "id,paths.id,paths.path">;
type Assert<T extends true> = T;

type SummaryHasOnlyRequestedFields = Assert<keyof LibrarySummary extends "id" | "type" | "name" ? true : false>;
type SummaryDoesNotExposeRelations = Assert<"mediaFiles" extends keyof LibrarySummary ? false : true>;
type NestedProjectionHasOnlyRequestedFields = Assert<keyof LibraryWithPaths extends "id" | "paths" ? true : false>;

// Runtime vehicle for the compile-time assertions above — tsc (check-types)
// fails here if SelectFields ever leaks unrequested fields into projections.
const typeChecks: [SummaryHasOnlyRequestedFields, SummaryDoesNotExposeRelations, NestedProjectionHasOnlyRequestedFields] = [
	true,
	true,
	true,
];

describe("SDK field projections", () => {
	test("type-level projections reject unrequested fields at compile time", () => {
		const library: LibrarySummary = { id: "library-1", name: "Movies", type: "movies" };
		const withPaths: LibraryWithPaths = { id: "library-1", paths: [{ id: "path-1", path: "/media/movies" }] };

		expect([library.id, withPaths.paths.length]).toEqual(["library-1", 1]);
		expect(typeChecks).toEqual([true, true, true]);
	});
});
