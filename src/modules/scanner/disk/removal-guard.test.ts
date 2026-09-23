import { beforeEach, describe, expect, test } from "bun:test";
import { RemovalGuard } from "./removal-guard";

function createGuard(existence: (path: string) => Promise<"exists" | "missing" | "unavailable">) {
	return new RemovalGuard({ existence, getIoConcurrency: () => 4 });
}

describe("RemovalGuard", () => {
	let existingPaths: Set<string>;
	let unavailablePaths: Set<string>;
	let guard: RemovalGuard;

	beforeEach(() => {
		existingPaths = new Set();
		unavailablePaths = new Set();
		guard = createGuard((path) => {
			if (unavailablePaths.has(path)) return Promise.resolve("unavailable");

			if (existingPaths.has(path)) return Promise.resolve("exists");

			return Promise.resolve("missing");
		});
	});

	test("confirms missing files as removable", async () => {
		const assessment = await guard.assess({
			libraryId: "lib-1",
			candidates: ["/media/a.mkv", "/media/b.mkv"],
			existingCount: 10,
			filesOnDiskCount: 8,
		});

		expect(assessment.removedFiles).toEqual(["/media/a.mkv", "/media/b.mkv"]);
		expect(assessment.storageUnavailable).toBeFalse();
		expect(assessment.massRemoval).toBeFalse();
		expect(assessment.skipRemovals).toBeFalse();
	});

	test("keeps files re-found on disk", async () => {
		existingPaths.add("/media/kept.mkv");

		const assessment = await guard.assess({ libraryId: "lib-1", candidates: ["/media/kept.mkv"], existingCount: 10, filesOnDiskCount: 10 });

		expect(assessment.removedFiles).toEqual([]);
		expect(assessment.skipRemovals).toBeFalse();
	});

	test("flags unavailable storage and refuses removals", async () => {
		unavailablePaths.add("/media/busy.mkv");

		const assessment = await guard.assess({
			libraryId: "lib-1",
			candidates: ["/media/busy.mkv", "/media/gone.mkv"],
			existingCount: 10,
			filesOnDiskCount: 5,
		});

		expect(assessment.storageUnavailable).toBeTrue();
		expect(assessment.skipRemovals).toBeTrue();
		expect(assessment.removedFiles).toEqual(["/media/gone.mkv"]);
	});

	test("detects a mass removal when most of the library vanishes", async () => {
		const candidates = Array.from({ length: 6 }, (_, index) => `/media/file-${index}.mkv`);

		const assessment = await guard.assess({ libraryId: "lib-1", candidates, existingCount: 10, filesOnDiskCount: 4 });

		expect(assessment.massRemoval).toBeTrue();
		expect(assessment.skipRemovals).toBeTrue();
		expect(assessment.removedFiles).toHaveLength(6);
	});

	test("treats an empty disk listing as a mass removal", async () => {
		const assessment = await guard.assess({ libraryId: "lib-1", candidates: ["/media/a.mkv"], existingCount: 10, filesOnDiskCount: 0 });

		expect(assessment.massRemoval).toBeTrue();
		expect(assessment.skipRemovals).toBeTrue();
	});

	test("propagates abort", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			guard.assess({ libraryId: "lib-1", candidates: ["/media/a.mkv"], existingCount: 10, filesOnDiskCount: 8, signal: controller.signal }),
		).rejects.toThrow();
	});
});
