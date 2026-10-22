import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTree } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { metadataSidecarsService } from "./metadata-sidecars.service";
import { SidecarMetadataStorageService } from "./sidecar-metadata-storage.service";
import { DatabaseSidecarSnapshotResolver } from "./sidecar-snapshot.resolver";

const db = useTestDatabase();

function firstRow<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected a row");

	return row;
}

function createStorageService(): SidecarMetadataStorageService {
	return new SidecarMetadataStorageService(metadataSidecarsService.createSidecarWriter(new DatabaseSidecarSnapshotResolver()));
}

async function movieIdFor(metadataId: string): Promise<string> {
	const movie = firstRow(
		await db.client().select({ id: schema.movies.id }).from(schema.movies).where(eq(schema.movies.stableKey, metadataId)),
	);

	return movie.id;
}

/** Writes a webp source, persists it as an image, and links it to the metadata as the poster. */
async function seedPoster(metadataId: string, sourcePath: string): Promise<void> {
	await Bun.write(
		sourcePath,
		await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } })
			.webp()
			.toBuffer(),
	);
	const client = db.client();
	const image = firstRow(
		await client
			.insert(schema.images)
			.values({ stableKey: crypto.randomUUID(), localPath: sourcePath, contentType: "image/webp" })
			.returning({ id: schema.images.id }),
	);
	await client.insert(schema.metadataImages).values({ metadataId, imageId: image.id, imageType: "poster" });
}

/** Seeds a series with one season and two episodes, under fixed ids the media inputs refer to. */
async function seedSeries(): Promise<void> {
	const client = db.client();
	await client.insert(schema.metadata).values({
		id: "series-1",
		stableKey: "series-1",
		title: "Show",
		type: "tv_show",
		releaseDate: "2019-01-01",
	});
	await client
		.insert(schema.seasons)
		.values({ id: "season-1", metadataId: "series-1", stableKey: "season-1", seasonNumber: 1, name: "Season One" });
	await client.insert(schema.episodes).values([
		{ id: "episode-1", seasonId: "season-1", stableKey: "episode-1", episodeNumber: 1, title: "Dulcinea" },
		{ id: "episode-2", seasonId: "season-1", stableKey: "episode-2", episodeNumber: 2, title: "Second" },
	]);
}

describe("SidecarMetadataStorageService", () => {
	test("writes a movie document next to the video for sidecar libraries", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const movieDirectory = join(root, "movie");
			await mkdir(movieDirectory);
			const mediaFilePath = join(movieDirectory, "movie.mkv");
			await insertMovieMediaFile(db.client(), mediaFilePath, "metadata-1");

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "database_and_sidecar", sidecarFlavor: "reelvault", paths: [{ path: root, metadataStorageMode: null }] },
				[{ filePath: mediaFilePath, metadataId: "metadata-1", movieId: await movieIdFor("metadata-1"), episodeId: null }],
			);

			expect(await readdir(movieDirectory)).toEqual(["movie.reelvault.nfo"]);
			expect(await metadataSidecarsService.readDocument(join(movieDirectory, "movie.reelvault.nfo"))).toMatchObject({
				title: "metadata-1",
			});
		} finally {
			await removeTree(root);
		}
	});

	test("writes no sidecar for files in database-only paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const movieDirectory = join(root, "movie");
			await mkdir(movieDirectory);
			const mediaFilePath = join(movieDirectory, "movie.mkv");
			await insertMovieMediaFile(db.client(), mediaFilePath, "metadata-1");

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "database", paths: [{ path: root, metadataStorageMode: null }] },
				[{ filePath: mediaFilePath, metadataId: "metadata-1", movieId: await movieIdFor("metadata-1"), episodeId: null }],
			);

			expect(await readdir(movieDirectory)).toEqual([]);
		} finally {
			await removeTree(root);
		}
	});

	test("writes the series, season and episode documents into their folders", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const showDirectory = join(root, "show");
			const seasonDirectory = join(showDirectory, "Season 01");
			await mkdir(seasonDirectory, { recursive: true });
			await seedSeries();

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "sidecar", paths: [{ path: root, metadataStorageMode: null }] },
				[
					{ filePath: join(seasonDirectory, "s01e01.mkv"), metadataId: "series-1", movieId: null, episodeId: "episode-1" },
					{ filePath: join(seasonDirectory, "s01e02.mkv"), metadataId: "series-1", movieId: null, episodeId: "episode-2" },
				],
			);

			expect((await readdir(showDirectory)).toSorted()).toEqual(["Season 01", "tvshow.reelvault.nfo"]);
			expect((await readdir(seasonDirectory)).toSorted()).toEqual([
				"s01e01.reelvault.nfo",
				"s01e02.reelvault.nfo",
				"season01-reelvault.nfo",
			]);
			expect(await metadataSidecarsService.readDocument(join(showDirectory, "tvshow.reelvault.nfo"))).toMatchObject({ title: "Show" });
			expect(await metadataSidecarsService.readDocument(join(seasonDirectory, "s01e01.reelvault.nfo"))).toMatchObject({
				title: "Dulcinea",
			});
		} finally {
			await removeTree(root);
		}
	});

	test("skips media files whose episode row is gone and writes nothing for them", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const seasonDirectory = join(root, "show", "Season 01");
			await mkdir(seasonDirectory, { recursive: true });

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "sidecar", paths: [{ path: root, metadataStorageMode: null }] },
				[{ filePath: join(seasonDirectory, "s01e01.mkv"), metadataId: "series-1", movieId: null, episodeId: "episode-404" }],
			);

			expect(await readdir(seasonDirectory)).toEqual([]);
		} finally {
			await removeTree(root);
		}
	});

	test("writes kodi-named documents and exports the poster beside them for kodi libraries", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const movieDirectory = join(root, "movie");
			await mkdir(movieDirectory);
			const mediaFilePath = join(movieDirectory, "movie.mkv");
			await insertMovieMediaFile(db.client(), mediaFilePath, "metadata-1");
			await seedPoster("metadata-1", join(root, "poster-source.webp"));

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "sidecar", sidecarFlavor: "kodi", paths: [{ path: root, metadataStorageMode: null }] },
				[{ filePath: mediaFilePath, metadataId: "metadata-1", movieId: await movieIdFor("metadata-1"), episodeId: null }],
			);

			expect((await readdir(movieDirectory)).toSorted()).toEqual(["movie.nfo", "poster.jpg"]);
			expect((await sharp(join(movieDirectory, "poster.jpg")).metadata()).format).toBe("jpeg");
		} finally {
			await removeTree(root);
		}
	});

	test("writes reelvault-named documents for a library that predates the flavor field", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-storage-"));
		try {
			const movieDirectory = join(root, "movie");
			await mkdir(movieDirectory);
			const mediaFilePath = join(movieDirectory, "movie.mkv");
			await insertMovieMediaFile(db.client(), mediaFilePath, "metadata-1");

			await createStorageService().saveLibraryMedia(
				{ metadataStorageMode: "sidecar", paths: [{ path: root, metadataStorageMode: null }] },
				[{ filePath: mediaFilePath, metadataId: "metadata-1", movieId: await movieIdFor("metadata-1"), episodeId: null }],
			);

			expect(await readdir(movieDirectory)).toEqual(["movie.reelvault.nfo"]);
		} finally {
			await removeTree(root);
		}
	});
});
