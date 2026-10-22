import { afterEach, describe, expect, test } from "bun:test";
import { systemResourcesService } from "@/config/system-resources.service";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { sidecarMetadataWriter } from "./sidecar-metadata-writer.runtime";
import { sidecarSyncService } from "./sidecar-sync.service";

// Libraries, titles, media files and the sync's grouping run against the migrated test database. The
// sync itself is real. Stubbed: `sidecarMetadataWriter.saveMovie`, the sidecar file write on disk (it
// records each call and can be gated or failed), and `systemResourcesService.getIoConcurrency`, the
// host capacity that bounds parallel syncs.
const db = useTestDatabase();
const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
});

async function seedLibrary(name: string, metadataStorageMode: "database" | "database_and_sidecar", path: string): Promise<string> {
	const [library] = await db
		.client()
		.insert(schema.libraries)
		.values({ name, type: "movies", metadataStorageMode })
		.returning({ id: schema.libraries.id });
	if (!library) throw new Error("Expected the library insert to return a row");
	await db.client().insert(schema.libraryPaths).values({ libraryId: library.id, stableKey: library.id, path });

	return library.id;
}

async function seedTitle(metadataId: string): Promise<string> {
	await db
		.client()
		.insert(schema.metadata)
		.values({ id: metadataId, stableKey: metadataId, title: metadataId, type: "movie", releaseDate: "2020-01-01" });
	const [movie] = await db.client().insert(schema.movies).values({ stableKey: metadataId, metadataId }).returning({ id: schema.movies.id });
	if (!movie) throw new Error("Expected the movie insert to return a row");

	return movie.id;
}

async function seedFile(libraryId: string, filePath: string, metadataId: string, movieId: string): Promise<void> {
	await db
		.client()
		.insert(schema.mediaFiles)
		.values({
			libraryId,
			metadataId,
			movieId,
			filePath,
			fileName: filePath.slice(filePath.lastIndexOf("/") + 1),
		});
}

/** Waits until `condition` holds, polling a bounded number of times so a sync that never starts fails loudly. */
async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) await Bun.sleep(5);
	if (!condition()) throw new Error("The expected sidecar write never happened");
}

describe("sidecarSyncService", () => {
	test("re-writes sidecars for every library holding the title's media files", async () => {
		const movieId = await seedTitle("metadata-1");
		const first = await seedLibrary("Movies", "database_and_sidecar", "/media");
		const second = await seedLibrary("Elsewhere", "database_and_sidecar", "/elsewhere");
		await seedFile(first, "/media/movie/movie.mkv", "metadata-1", movieId);
		await seedFile(second, "/elsewhere/movie/movie.mkv", "metadata-1", movieId);
		const savedMovies: string[] = [];
		activeStubs.push(
			stubMethod(sidecarMetadataWriter, "saveMovie", (input: { metadataId: string; movieDirectory: string }) => {
				savedMovies.push(`${input.metadataId}:${input.movieDirectory}`);

				return Promise.resolve({ documentPath: "", writtenFiles: [] });
			}),
		);

		await sidecarSyncService.syncForMetadata("metadata-1");

		expect(savedMovies.toSorted((a, b) => a.localeCompare(b))).toEqual(["metadata-1:/elsewhere/movie", "metadata-1:/media/movie"]);
	});

	test("a library that keeps metadata only in the database gets no sidecar writes", async () => {
		const movieId = await seedTitle("metadata-1");
		const libraryId = await seedLibrary("Movies", "database", "/media");
		await seedFile(libraryId, "/media/movie/movie.mkv", "metadata-1", movieId);
		let saveCalls = 0;
		activeStubs.push(
			stubMethod(sidecarMetadataWriter, "saveMovie", () => {
				saveCalls++;

				return Promise.resolve({ documentPath: "", writtenFiles: [] });
			}),
		);

		await sidecarSyncService.syncForMetadata("metadata-1");

		expect(saveCalls).toBe(0);
	});

	test("a failed sidecar write is reported as a warning, and the next sync still runs", async () => {
		const movieId = await seedTitle("metadata-1");
		const libraryId = await seedLibrary("Movies", "database_and_sidecar", "/media");
		await seedFile(libraryId, "/media/movie/movie.mkv", "metadata-1", movieId);
		const warnings: string[] = [];
		let attempts = 0;
		activeStubs.push(
			stubMethod(sidecarSyncService.logger, "warn", (message: string) => {
				warnings.push(message);

				return undefined;
			}),
			stubMethod(sidecarMetadataWriter, "saveMovie", () => {
				attempts++;

				return attempts === 1 ? Promise.reject(new Error("disk full")) : Promise.resolve({ documentPath: "", writtenFiles: [] });
			}),
		);

		sidecarSyncService.scheduleSync("metadata-1");
		await until(() => warnings.length === 1);
		expect(warnings).toEqual(["Sidecar sync failed"]);

		sidecarSyncService.scheduleSync("metadata-1");
		await until(() => attempts === 2);
		expect(attempts).toBe(2);
	});
});

describe("sidecarSyncService scheduling", () => {
	test("repeated requests for one title coalesce into one re-run", async () => {
		const movieId = await seedTitle("metadata-coalesce");
		const libraryId = await seedLibrary("Movies", "database_and_sidecar", "/media");
		await seedFile(libraryId, "/media/coalesce/coalesce.mkv", "metadata-coalesce", movieId);
		const gates: Array<() => void> = [];
		let calls = 0;
		activeStubs.push(
			stubMethod(sidecarMetadataWriter, "saveMovie", () => {
				calls++;

				return new Promise((resolve) => {
					gates.push(() => resolve({ documentPath: "", writtenFiles: [] }));
				});
			}),
		);

		sidecarSyncService.scheduleSync("metadata-coalesce");
		sidecarSyncService.scheduleSync("metadata-coalesce");
		sidecarSyncService.scheduleSync("metadata-coalesce");
		await until(() => calls === 1);
		await Bun.sleep(20);
		expect(calls).toBe(1);

		gates[0]?.();
		// Exactly one re-run for the requests that arrived while the first ran.
		await until(() => calls === 2);
		await Bun.sleep(20);
		expect(calls).toBe(2);

		gates[1]?.();
	});

	test("concurrent title syncs are bounded by the io concurrency", async () => {
		const movieA = await seedTitle("metadata-a");
		const movieB = await seedTitle("metadata-b");
		const libraryId = await seedLibrary("Movies", "database_and_sidecar", "/media");
		await seedFile(libraryId, "/media/a/a.mkv", "metadata-a", movieA);
		await seedFile(libraryId, "/media/b/b.mkv", "metadata-b", movieB);
		const started: string[] = [];
		const gates = new Map<string, () => void>();
		activeStubs.push(
			stubMethod(systemResourcesService, "getIoConcurrency", () => 1),
			stubMethod(sidecarMetadataWriter, "saveMovie", (input: { metadataId: string }) => {
				started.push(input.metadataId);

				return new Promise((resolve) => {
					gates.set(input.metadataId, () => resolve({ documentPath: "", writtenFiles: [] }));
				});
			}),
		);

		sidecarSyncService.scheduleSync("metadata-a");
		sidecarSyncService.scheduleSync("metadata-b");
		await until(() => started.length === 1);
		await Bun.sleep(20);
		expect(started).toEqual(["metadata-a"]);

		gates.get("metadata-a")?.();
		await until(() => started.length === 2);
		expect(started).toEqual(["metadata-a", "metadata-b"]);

		gates.get("metadata-b")?.();
	});
});
