import { afterEach, expect, test } from "bun:test";
import { providerService } from "@/plugins/capabilities/provider.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertLibraries, insertScanFindings, selectScanFindings } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { librariesService } from "./libraries.service";

// Libraries and scan findings are seeded in the migrated test database and read back after
// each call. The only stub is the external metadata provider search: the query it receives
// is the observable output of the title parsing.
const db = useTestDatabase();
const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

async function seedLibrary(type: "movies" | "tv_shows"): Promise<string> {
	const [row] = await insertLibraries(db.client(), { name: "Library", type });
	if (!row) throw new Error("Expected the insert to return a library");

	return row.id;
}

async function seedFinding(libraryId: string, filePath: string, reason: "no_metadata_match" | "probe_failed"): Promise<void> {
	await insertScanFindings(db.client(), { libraryId, filePath, fileName: filePath.slice(filePath.lastIndexOf("/") + 1), reason });
}

async function storedFinding(filePath: string) {
	const rows = await selectScanFindings(db.client());

	return rows.find((row) => row.filePath === filePath);
}

test("setScanFindingIgnored ignores or restores a finding and reports a missing one", async () => {
	const libraryId = await seedLibrary("movies");
	await seedFinding(libraryId, "/media/a.mkv", "no_metadata_match");

	expect(await librariesService.setScanFindingIgnored(libraryId, "/media/a.mkv", true)).toEqual({
		filePath: "/media/a.mkv",
		ignored: true,
	});
	expect((await storedFinding("/media/a.mkv"))?.ignoredAt).toBeInstanceOf(Date);

	expect(await librariesService.setScanFindingIgnored(libraryId, "/media/a.mkv", false)).toEqual({
		filePath: "/media/a.mkv",
		ignored: false,
	});
	expect((await storedFinding("/media/a.mkv"))?.ignoredAt).toBeNull();

	await expect(librariesService.setScanFindingIgnored(libraryId, "/media/missing.mkv", true)).rejects.toMatchObject({
		code: "entity.not_found",
	});
});

test("getScanFindingCandidates searches the parsed title and year of a no-match finding", async () => {
	const libraryId = await seedLibrary("movies");
	await seedFinding(libraryId, "/media/Some.Movie.2019.1080p.mkv", "no_metadata_match");
	const providers = [{ providerId: "tmdb", results: [{ externalId: "603", title: "Some Movie", releaseDate: "2019-05-01" }] }];
	const search = stubMethod(providerService, "search", () => Promise.resolve(providers));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates(libraryId, "/media/Some.Movie.2019.1080p.mkv");

	expect(search.calls).toEqual([[{ type: "movie", title: "Some Movie", year: 2019 }]]);
	expect(response).toEqual({ searchTitle: "Some Movie", searchYear: 2019, candidates: providers });
});

test("getScanFindingCandidates searches a TV library as tv_show and leaves the year out when the name has none", async () => {
	const libraryId = await seedLibrary("tv_shows");
	await seedFinding(libraryId, "/media/Show.S01E01.mkv", "no_metadata_match");
	const search = stubMethod(providerService, "search", () => Promise.resolve([]));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates(libraryId, "/media/Show.S01E01.mkv");

	expect(search.calls).toEqual([[{ type: "tv_show", title: "Show" }]]);
	expect(response).toEqual({ searchTitle: "Show", searchYear: null, candidates: [] });
});

test("getScanFindingCandidates does not search a finding that failed for another reason", async () => {
	const libraryId = await seedLibrary("movies");
	await seedFinding(libraryId, "/media/Some.Movie.2019.mkv", "probe_failed");
	const search = stubMethod(providerService, "search", () => Promise.resolve([]));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates(libraryId, "/media/Some.Movie.2019.mkv");

	expect(search.calls).toEqual([]);
	expect(response).toEqual({ searchTitle: "Some Movie", searchYear: 2019, candidates: [] });
});
