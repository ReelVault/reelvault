import { afterEach, describe, expect, test } from "bun:test";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { sidecarMetadataWriter } from "./sidecar-metadata-writer.runtime";
import { sidecarSyncService } from "./sidecar-sync.service";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("sidecarSyncService", () => {
	test("re-writes sidecars for every library holding the title's media files", async () => {
		const mediaFiles = await import("@/database/repositories/media-files.repository");
		const libraries = await import("@/database/repositories/libraries.repository");
		const savedMovies: string[] = [];
		activeStubs.push(
			stubMethod(mediaFiles.mediaRepository, "findRootsByMetadataId", () =>
				Promise.resolve([
					{ libraryId: "library-1", filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null },
					{ libraryId: "library-2", filePath: "/elsewhere/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null },
				]),
			),
			stubMethod(libraries.librariesRepository, "findWithPaths", (libraryId: string) =>
				Promise.resolve({
					id: libraryId,
					metadataStorageMode: "database_and_sidecar",
					paths: [{ path: "/media", metadataStorageMode: null }],
				}),
			),
			stubMethod(sidecarMetadataWriter, "saveMovie", (input: { metadataId: string; movieDirectory: string }) => {
				savedMovies.push(`${input.metadataId}:${input.movieDirectory}`);

				return Promise.resolve({ documentPath: "", writtenFiles: [] });
			}),
		);

		await sidecarSyncService.syncForMetadata("metadata-1");

		expect(savedMovies).toEqual(["metadata-1:/media/movie", "metadata-1:/elsewhere/movie"]);
	});

	test("a library without sidecars produces no writes and no failure", async () => {
		const mediaFiles = await import("@/database/repositories/media-files.repository");
		const libraries = await import("@/database/repositories/libraries.repository");
		let saveCalls = 0;
		activeStubs.push(
			stubMethod(mediaFiles.mediaRepository, "findRootsByMetadataId", () =>
				Promise.resolve([
					{ libraryId: "library-1", filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null },
				]),
			),
			stubMethod(libraries.librariesRepository, "findWithPaths", () =>
				Promise.resolve({ id: "library-1", metadataStorageMode: "database", paths: [{ path: "/media", metadataStorageMode: null }] }),
			),
			stubMethod(sidecarMetadataWriter, "saveMovie", () => {
				saveCalls++;

				return Promise.resolve({ documentPath: "", writtenFiles: [] });
			}),
		);

		await sidecarSyncService.syncForMetadata("metadata-1");

		expect(saveCalls).toBe(0);
	});

	test("scheduleSync swallows sync failures in the background", async () => {
		const mediaFiles = await import("@/database/repositories/media-files.repository");
		const warnings: string[] = [];
		activeStubs.push(
			stubMethod(sidecarSyncService.logger, "warn", (message: string) => {
				warnings.push(message);

				return undefined;
			}),
			stubMethod(mediaFiles.mediaRepository, "findRootsByMetadataId", () => Promise.reject(new Error("database unavailable"))),
		);

		sidecarSyncService.scheduleSync("metadata-1");
		await new Promise((resolve) => {
			setTimeout(resolve, 20);
		});

		expect(warnings).toEqual(["Sidecar sync failed"]);
	});

	test("coalesces repeated requests for the same title into one re-run", async () => {
		const gates: Array<() => void> = [];
		let calls = 0;
		activeStubs.push(
			stubMethod(sidecarSyncService, "syncForMetadata", () => {
				calls++;

				return new Promise<void>((resolve) => {
					gates.push(resolve);
				});
			}),
		);

		sidecarSyncService.scheduleSync("metadata-coalesce");
		sidecarSyncService.scheduleSync("metadata-coalesce");
		sidecarSyncService.scheduleSync("metadata-coalesce");
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});

		expect(calls).toBe(1);
		gates[0]?.();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});

		// Exactly one re-run for the requests that arrived while the first ran.
		expect(calls).toBe(2);
		gates[1]?.();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(calls).toBe(2);
	});

	test("bounds concurrent sidecar syncs by the io concurrency", async () => {
		const { systemResourcesService } = await import("@/system/system-resources.service");
		const started: string[] = [];
		const gates = new Map<string, () => void>();
		activeStubs.push(
			stubMethod(systemResourcesService, "getIoConcurrency", () => 1),
			stubMethod(sidecarSyncService, "syncForMetadata", (metadataId: string) => {
				started.push(metadataId);

				return new Promise<void>((resolve) => {
					gates.set(metadataId, resolve);
				});
			}),
		);

		sidecarSyncService.scheduleSync("metadata-a");
		sidecarSyncService.scheduleSync("metadata-b");
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});

		expect(started).toEqual(["metadata-a"]);
		gates.get("metadata-a")?.();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		expect(started).toEqual(["metadata-a", "metadata-b"]);
		gates.get("metadata-b")?.();
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
	});
});
