import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { removeTree } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { scannerService } from "./scanner.service";

const db = useTestDatabase();
const stubs: Array<{ restore(): void }> = [];

type TestClient = ReturnType<typeof db.client>;

interface IngestedStats {
	size: number;
	sourceMtimeMs: number;
}

interface Show {
	libraryId: string;
	metadataId: string;
	seasonId: string;
}

let workDir = "";
let libraryRoot = "";

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "reelvault-scanner-"));
	libraryRoot = join(workDir, "library");
	await mkdir(libraryRoot);
	// External plugin handlers are the boundary: the removal path emits into them.
	stubs.push(stubMethod(pluginEventBus, "emit", () => Promise.resolve()));
});

afterEach(async () => {
	for (const stub of stubs.splice(0)) stub.restore();
	await removeTree(workDir);
});

function first<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row;
}

async function writeVideo(name: string): Promise<string> {
	const filePath = join(libraryRoot, name);
	await writeFile(filePath, "video");

	return filePath;
}

/** The size and mtime a row holds once its file was ingested, as the scanner stats them. */
async function ingestedStats(filePath: string): Promise<IngestedStats> {
	const fileStat = await stat(filePath);

	return { size: fileStat.size, sourceMtimeMs: Math.floor(fileStat.mtimeMs) };
}

async function insertRow(client: TestClient, filePath: string, metadataId: string, stats?: IngestedStats): Promise<string> {
	const mediaFileId = await insertMovieMediaFile(client, filePath, metadataId);
	if (stats) await client.update(schema.mediaFiles).set(stats).where(eq(schema.mediaFiles.id, mediaFileId));

	return mediaFileId;
}

async function libraryIdOf(client: TestClient, mediaFileId: string): Promise<string> {
	const [row] = await client
		.select({ libraryId: schema.mediaFiles.libraryId })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, mediaFileId));
	if (!row) throw new Error(`Media file ${mediaFileId} was not inserted`);

	return row.libraryId;
}

async function remainingMediaIds(client: TestClient, libraryId: string): Promise<string[]> {
	const rows = await client.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(eq(schema.mediaFiles.libraryId, libraryId));

	return rows.map((row) => row.id).toSorted();
}

async function seedShow(client: TestClient): Promise<Show> {
	const library = first(
		await client.insert(schema.libraries).values({ name: "Shows", type: "tv_shows" }).returning({ id: schema.libraries.id }),
	);
	const metadata = first(
		await client
			.insert(schema.metadata)
			.values({ id: "show-1", stableKey: "show-1", title: "Show", type: "tv_show", releaseDate: "2020-01-01" })
			.returning({ id: schema.metadata.id }),
	);
	const season = first(
		await client
			.insert(schema.seasons)
			.values({ stableKey: "show-1-s1", metadataId: metadata.id, seasonNumber: 1 })
			.returning({ id: schema.seasons.id }),
	);

	return { libraryId: library.id, metadataId: metadata.id, seasonId: season.id };
}

async function insertEpisodeFile(client: TestClient, show: Show, filePath: string, episodeNumber: number): Promise<void> {
	const episode = first(
		await client
			.insert(schema.episodes)
			.values({ stableKey: `show-1-s1e${episodeNumber}`, seasonId: show.seasonId, episodeNumber })
			.returning({ id: schema.episodes.id }),
	);
	await client.insert(schema.mediaFiles).values({
		libraryId: show.libraryId,
		metadataId: show.metadataId,
		episodeId: episode.id,
		filePath,
		fileName: basename(filePath),
	});
}

describe("ScannerService.scanPaths against the library rows", () => {
	test("returns empty results and removes nothing when no paths are given", async () => {
		const client = db.client();
		const mediaFileId = await insertMovieMediaFile(client, join(libraryRoot, "a.mkv"), "movie-a");
		const libraryId = await libraryIdOf(client, mediaFileId);

		const result = await scannerService.scanPaths(libraryId, "movie", []);

		expect(result).toEqual({ filePaths: [], newFilePaths: [], changedMediaFileIds: [], removedFilePaths: [] });
		expect(await remainingMediaIds(client, libraryId)).toEqual([mediaFileId]);
	});

	test("reports only unknown files as new and leaves rows outside the scan roots alone", async () => {
		const client = db.client();
		const newFile = await writeVideo("a.mkv");
		const knownFile = await writeVideo("b.mkv");
		const knownId = await insertRow(client, knownFile, "movie-b", await ingestedStats(knownFile));
		const outsideId = await insertRow(client, "/elsewhere/outside.mkv", "movie-outside");
		const libraryId = await libraryIdOf(client, knownId);

		const result = await scannerService.scanPaths(libraryId, "movie", [libraryRoot]);

		expect(result.filePaths.toSorted()).toEqual([knownFile, newFile].toSorted());
		expect(result.newFilePaths).toEqual([newFile]);
		expect(result.changedMediaFileIds).toEqual([]);
		expect(result.removedFilePaths).toEqual([]);
		expect(await remainingMediaIds(client, libraryId)).toEqual([knownId, outsideId].toSorted());
	});

	test.each([
		["size", { size: 999 }],
		["mtime", { sourceMtimeMs: 1 }],
	])("flags a file whose %s drifted from the row it was ingested with", async (_field, drift) => {
		const client = db.client();
		const filePath = await writeVideo("a.mkv");
		const mediaFileId = await insertRow(client, filePath, "movie-a", { ...(await ingestedStats(filePath)), ...drift });
		const libraryId = await libraryIdOf(client, mediaFileId);

		const result = await scannerService.scanPaths(libraryId, "movie", [libraryRoot]);

		expect(result.changedMediaFileIds).toEqual([mediaFileId]);
	});

	test("removes the row of a file that is gone while its library root is still reachable", async () => {
		const client = db.client();
		const survivingFile = await writeVideo("b.mkv");
		const survivingId = await insertRow(client, survivingFile, "movie-b", await ingestedStats(survivingFile));
		await insertRow(client, join(libraryRoot, "a.mkv"), "movie-a");
		const libraryId = await libraryIdOf(client, survivingId);

		const result = await scannerService.scanPaths(libraryId, "movie", [libraryRoot]);

		expect(result.removedFilePaths).toEqual([join(libraryRoot, "a.mkv")]);
		expect(await remainingMediaIds(client, libraryId)).toEqual([survivingId]);
	});

	test("keeps every row when the scan finds drastically fewer files than the database", async () => {
		const client = db.client();
		const firstId = await insertRow(client, join(libraryRoot, "gone-1.mkv"), "movie-gone-1");
		const libraryId = await libraryIdOf(client, firstId);
		const ids = [firstId];
		for (const index of [2, 3, 4, 5, 6]) {
			ids.push(await insertRow(client, join(libraryRoot, `gone-${index}.mkv`), `movie-gone-${index}`));
		}
		const newFile = await writeVideo("new.mkv");

		const result = await scannerService.scanPaths(libraryId, "movie", [libraryRoot]);

		expect(result.newFilePaths).toEqual([newFile]);
		expect(result.removedFilePaths).toEqual([]);
		expect(await remainingMediaIds(client, libraryId)).toEqual(ids.toSorted());
	});
});

describe("ScannerService.scanPaths range files", () => {
	test("re-ingests a range file that owns fewer rows than its name spans", async () => {
		const client = db.client();
		const show = await seedShow(client);
		const rangeFile = await writeVideo("Show.S01E01-E03.mkv");
		await insertEpisodeFile(client, show, rangeFile, 1);

		const result = await scannerService.scanPaths(show.libraryId, "tv_show", [libraryRoot]);

		expect(result.newFilePaths).toEqual([rangeFile]);
	});

	test("does not re-ingest a range file once every covered episode has a row", async () => {
		const client = db.client();
		const show = await seedShow(client);
		const rangeFile = await writeVideo("Show.S01E01-E03.mkv");
		for (const episodeNumber of [1, 2, 3]) await insertEpisodeFile(client, show, rangeFile, episodeNumber);

		const result = await scannerService.scanPaths(show.libraryId, "tv_show", [libraryRoot]);

		expect(result.newFilePaths).toEqual([]);
	});

	test("does not re-ingest a range longer than the supported episode span", async () => {
		const client = db.client();
		const show = await seedShow(client);
		const rangeFile = await writeVideo("Show.S01E01-E99.mkv");
		await insertEpisodeFile(client, show, rangeFile, 1);

		const result = await scannerService.scanPaths(show.libraryId, "tv_show", [libraryRoot]);

		expect(result.newFilePaths).toEqual([]);
	});
});
