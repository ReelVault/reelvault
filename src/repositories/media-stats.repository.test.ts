import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { getCatalogMediaStats, getLibraryMediaStats, rebuildMediaStats } from "@/repositories/media-stats.repository";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";

const db = useTestDatabase();

async function seedTargets(): Promise<void> {
	const client = db.client();
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Library", type: "movies" });
	await client.insert(schema.metadata).values([
		{ id: "meta-movie", stableKey: "movie", title: "Heat", type: "movie", releaseDate: "1995-12-15" },
		{ id: "meta-show", stableKey: "show", title: "Show", type: "tv_show", releaseDate: "2000-01-01" },
	]);
	await client.insert(schema.movies).values({ id: "movie-1", stableKey: "movie-1", metadataId: "meta-movie" });
	await client.insert(schema.seasons).values({ id: "season-1", stableKey: "show-s1", metadataId: "meta-show", seasonNumber: 1 });
	await client.insert(schema.episodes).values({ id: "episode-1", stableKey: "show-s1e1", seasonId: "season-1", episodeNumber: 1 });
}

async function createMovieFile(overrides: { size?: number; qualityTag?: string | null } = {}): Promise<string> {
	const created = await mediaRepository.createWithStreams({
		libraryId: "lib-1",
		metadataId: "meta-movie",
		movieId: "movie-1",
		episodeId: null,
		filePath: "/media/heat.mkv",
		fileName: "heat.mkv",
		formatName: "matroska",
		duration: 3_600,
		size: overrides.size ?? 1_000,
		bitRate: null,
		source: null,
		edition: null,
		qualityTag: overrides.qualityTag ?? null,
		sourceMtimeMs: null,
		isEnabled: true,
		videoStreams: [],
		audioStreams: [],
	});

	return created.mediaFile.id;
}

const TECHNICAL_DATA = {
	formatName: "matroska",
	duration: 3_600,
	bitRate: null,
	source: null,
	edition: null,
	qualityTag: "1080p",
	videoStreams: [],
	audioStreams: [],
	subtitles: [],
};

describe("media statistics summary writes", () => {
	test("counts a media file inserted through the repository", async () => {
		await seedTargets();
		await rebuildMediaStats();
		await createMovieFile();

		expect(await getCatalogMediaStats()).toEqual({
			fileCount: 1,
			totalSize: 1_000,
			movieCount: 1,
			episodeCount: 0,
			qualityCount: 0,
		});
		const libraryStats = await getLibraryMediaStats(["lib-1"]);
		expect(libraryStats.get("lib-1")).toEqual({ fileCount: 1, totalSize: 1_000 });
	});

	test("applies the size and quality delta of a technical refresh", async () => {
		await seedTargets();
		await rebuildMediaStats();
		const mediaFileId = await createMovieFile();

		await mediaRepository.replaceTechnicalData({
			mediaFileId,
			data: TECHNICAL_DATA,
			size: 2_500,
			sourceMtimeMs: 123,
		});

		expect(await getCatalogMediaStats()).toMatchObject({ fileCount: 1, totalSize: 2_500, qualityCount: 1 });
		const libraryStats = await getLibraryMediaStats(["lib-1"]);
		expect(libraryStats.get("lib-1")).toEqual({ fileCount: 1, totalSize: 2_500 });
	});

	test("applies the quality delta of a direct edit", async () => {
		await seedTargets();
		await rebuildMediaStats();
		const mediaFileId = await createMovieFile();

		await mediaRepository.updateAndRead(mediaFileId, { qualityTag: "2160p" });

		expect(await getCatalogMediaStats()).toMatchObject({ fileCount: 1, qualityCount: 1 });
	});

	test("moves the movie and episode counters when a file is reassigned", async () => {
		await seedTargets();
		await rebuildMediaStats();
		const mediaFileId = await createMovieFile();

		await mediaRepository.reassign({
			mediaFileId,
			metadataId: "meta-show",
			movieId: null,
			episodeId: "episode-1",
		});

		expect(await getCatalogMediaStats()).toMatchObject({ fileCount: 1, movieCount: 0, episodeCount: 1 });
		const libraryStats = await getLibraryMediaStats(["lib-1"]);
		expect(libraryStats.get("lib-1")).toEqual({ fileCount: 1, totalSize: 1_000 });
	});

	test("removes the counters when the last media file is deleted", async () => {
		await seedTargets();
		await rebuildMediaStats();
		const mediaFileId = await createMovieFile();

		await mediaRepository.deleteByIds([mediaFileId]);

		expect(await getCatalogMediaStats()).toEqual({
			fileCount: 0,
			totalSize: 0,
			movieCount: 0,
			episodeCount: 0,
			qualityCount: 0,
		});
		const libraryStats = await getLibraryMediaStats(["lib-1"]);
		expect(libraryStats.get("lib-1")).toEqual({ fileCount: 0, totalSize: 0 });
	});
});

describe("media statistics summary rebuilds", () => {
	test("recomputes the catalog after deleting a library", async () => {
		await seedTargets();
		await rebuildMediaStats();
		await createMovieFile();

		await librariesRepository.deleteWithDependents("lib-1");

		expect(await getCatalogMediaStats()).toEqual({
			fileCount: 0,
			totalSize: 0,
			movieCount: 0,
			episodeCount: 0,
			qualityCount: 0,
		});
		expect(await getLibraryMediaStats(["lib-1"])).toEqual(new Map());
	});

	test("rebuilds every counter from the media files", async () => {
		await seedTargets();
		await db.client().insert(schema.mediaFiles).values({
			id: "mf-direct",
			libraryId: "lib-1",
			metadataId: "meta-movie",
			movieId: "movie-1",
			fileName: "direct.mkv",
			filePath: "/media/direct.mkv",
			size: 4_000,
			qualityTag: "1080p",
		});

		await rebuildMediaStats();

		expect(await getCatalogMediaStats()).toEqual({
			fileCount: 1,
			totalSize: 4_000,
			movieCount: 1,
			episodeCount: 0,
			qualityCount: 1,
		});
	});
});
