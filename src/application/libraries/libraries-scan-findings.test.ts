import { afterEach, expect, test } from "bun:test";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { providerService } from "@/plugins/capabilities/provider.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { librariesService } from "./libraries.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function stubLibraryExists(): void {
	stubs.push(stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lib-1" })));
}

test("getScanFindings lists the requested status and returns the counts of both", async () => {
	stubLibraryExists();
	const list = stubMethod(scanFindingsRepository, "listWithCounts", () => ({
		items: [{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }],
		counts: { active: 1, ignored: 2 },
	}));
	stubs.push(list);

	const response = await librariesService.getScanFindings("lib-1", "ignored");

	expect(list.calls).toEqual([["lib-1", "ignored"]]);
	expect(response).toEqual({
		data: [{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }],
		counts: { active: 1, ignored: 2 },
	});
});

test("getScanFindings defaults to the active findings", async () => {
	stubLibraryExists();
	const list = stubMethod(scanFindingsRepository, "listWithCounts", () => ({ items: [], counts: { active: 0, ignored: 0 } }));
	stubs.push(list);

	await librariesService.getScanFindings("lib-1");

	expect(list.calls).toEqual([["lib-1", "active"]]);
});

test("setScanFindingIgnored ignores or restores a finding and reports a missing one", async () => {
	stubLibraryExists();
	let found = true;
	stubs.push(stubMethod(scanFindingsRepository, "setIgnored", () => Promise.resolve(found)));

	expect(await librariesService.setScanFindingIgnored("lib-1", "/media/a.mkv", true)).toEqual({
		filePath: "/media/a.mkv",
		ignored: true,
	});
	expect(await librariesService.setScanFindingIgnored("lib-1", "/media/a.mkv", false)).toEqual({
		filePath: "/media/a.mkv",
		ignored: false,
	});

	found = false;
	await expect(librariesService.setScanFindingIgnored("lib-1", "/media/missing.mkv", true)).rejects.toMatchObject({
		code: "entity.not_found",
	});
});

test("getScanFindingCandidates searches the parsed title and year of a no-match finding", async () => {
	stubs.push(stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lib-1", type: "movies" })));
	stubs.push(
		stubMethod(scanFindingsRepository, "findByPath", () =>
			Promise.resolve({ filePath: "/media/Some.Movie.2019.1080p.mkv", fileName: "Some.Movie.2019.1080p.mkv", reason: "no_metadata_match" }),
		),
	);
	const providers = [{ providerId: "tmdb", results: [{ externalId: "603", title: "Some Movie", releaseDate: "2019-05-01" }] }];
	const search = stubMethod(providerService, "search", () => Promise.resolve(providers));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates("lib-1", "/media/Some.Movie.2019.1080p.mkv");

	expect(search.calls).toEqual([[{ type: "movie", title: "Some Movie", year: 2019 }]]);
	expect(response).toEqual({ searchTitle: "Some Movie", searchYear: 2019, candidates: providers });
});

test("getScanFindingCandidates searches a TV library as tv_show and leaves the year out when the name has none", async () => {
	stubs.push(stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lib-1", type: "tv_shows" })));
	stubs.push(
		stubMethod(scanFindingsRepository, "findByPath", () =>
			Promise.resolve({ filePath: "/media/Show.S01E01.mkv", fileName: "Show.S01E01.mkv", reason: "no_metadata_match" }),
		),
	);
	const search = stubMethod(providerService, "search", () => Promise.resolve([]));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates("lib-1", "/media/Show.S01E01.mkv");

	expect(search.calls).toEqual([[{ type: "tv_show", title: "Show" }]]);
	expect(response).toEqual({ searchTitle: "Show", searchYear: null, candidates: [] });
});

test("getScanFindingCandidates does not search a finding that failed for another reason", async () => {
	stubs.push(stubMethod(librariesRepository, "findByIdForRead", () => Promise.resolve({ id: "lib-1", type: "movies" })));
	stubs.push(
		stubMethod(scanFindingsRepository, "findByPath", () =>
			Promise.resolve({ filePath: "/media/Some.Movie.2019.mkv", fileName: "Some.Movie.2019.mkv", reason: "probe_failed" }),
		),
	);
	const search = stubMethod(providerService, "search", () => Promise.resolve([]));
	stubs.push(search);

	const response = await librariesService.getScanFindingCandidates("lib-1", "/media/Some.Movie.2019.mkv");

	expect(search.calls).toEqual([]);
	expect(response).toEqual({ searchTitle: "Some Movie", searchYear: 2019, candidates: [] });
});
