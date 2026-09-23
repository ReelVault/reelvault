import { afterEach, describe, expect, test } from "bun:test";
import type { SidecarArtworkWriter } from "./saver/sidecar-artwork.exporter";
import type { SidecarMetadataWriter } from "./sidecar.types";
import { SidecarMetadataStorageService } from "./sidecar-metadata-storage.service";

/** Replaces a method on the live singleton for one test.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method);
	Reflect.set(target, method, (...args: never[]) => impl(...args));

	return {
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function recordingWriter() {
	const calls: string[] = [];
	const writeResult = () => Promise.resolve({ documentPath: "", writtenFiles: [] });
	const writer: SidecarMetadataWriter = {
		saveMovie: (input) => {
			calls.push(`movie:${input.metadataId}:${input.movieDirectory}:${input.flavor ?? "reelvault"}`);

			return writeResult();
		},
		saveSeries: (input) => {
			calls.push(`series:${input.metadataId}:${input.seriesDirectory}:${input.flavor ?? "reelvault"}`);

			return writeResult();
		},
		saveSeason: (input) => {
			calls.push(`season:${input.seasonId}:${input.seasonDirectory}:${input.flavor ?? "reelvault"}`);

			return writeResult();
		},
		saveEpisode: (input) => {
			calls.push(`episode:${input.episodeId}:${input.episodeDirectory}:${input.flavor ?? "reelvault"}`);

			return writeResult();
		},
	};

	return { calls, writer };
}

function recordingArtwork(): SidecarArtworkWriter & { calls: string[] } {
	const calls: string[] = [];

	return {
		calls,
		saveTitleArtwork: (input) => {
			calls.push(`title:${input.metadataId}:${input.directory}`);

			return Promise.resolve([]);
		},
		saveSeasonArtwork: (input) => {
			calls.push(`season:${input.directory}:${input.seasonNumber}`);

			return Promise.resolve([]);
		},
		saveEpisodeArtwork: (input) => {
			calls.push(`episode:${input.directory}:${input.videoBaseName}`);

			return Promise.resolve([]);
		},
	};
}

describe("SidecarMetadataStorageService", () => {
	test("writes a movie sidecar for database_and_sidecar libraries", async () => {
		const { calls, writer } = recordingWriter();

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "database_and_sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[{ filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null }],
		);

		expect(calls).toEqual(["movie:metadata-1:/media/movie:reelvault"]);
	});

	test("skips files in database-only paths without any writer calls", async () => {
		const { calls, writer } = recordingWriter();

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "database", paths: [{ path: "/media", metadataStorageMode: null }] },
			[
				{ filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null },
				{ filePath: "/media/movie/other.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null },
			],
		);

		expect(calls).toEqual([]);
	});

	test("writes series/season sidecars once per directory for episode files", async () => {
		const { calls, writer } = recordingWriter();
		const episodes = await import("@/database/repositories/episodes.repository");
		const seasons = await import("@/database/repositories/seasons.repository");
		activeStubs.push(
			stubMethod(episodes.episodesRepository, "findByPrimaryId", (input: { primaryId: string }) =>
				Promise.resolve({
					id: input.primaryId,
					seasonId: "season-1",
					title: "Dulcinea",
					episodeNumber: 1,
					airDate: null,
					overview: null,
					imageId: null,
				}),
			),
			stubMethod(seasons.seasonsRepository, "findByPrimaryId", () =>
				Promise.resolve({
					id: "season-1",
					seasonNumber: 1,
					name: "Season One",
					airDate: null,
					overview: null,
					status: null,
					imageId: null,
				}),
			),
		);

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[
				{ filePath: "/media/show/Season 01/s01e01.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-1" },
				{ filePath: "/media/show/Season 01/s01e02.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-2" },
			],
		);

		expect(calls).toContain("series:metadata-1:/media/show:reelvault");
		expect(calls).toContain("season:season-1:/media/show/Season 01:reelvault");
		expect(calls.filter((call) => call.startsWith("series:"))).toHaveLength(1);
		expect(calls.filter((call) => call.startsWith("season:"))).toHaveLength(1);
		expect(calls.filter((call) => call.startsWith("episode:episode-1"))).toHaveLength(1);
		expect(calls.filter((call) => call.startsWith("episode:episode-2"))).toHaveLength(1);
	});

	test("skips media files whose episode row disappeared mid-scan", async () => {
		const { calls, writer } = recordingWriter();
		const episodes = await import("@/database/repositories/episodes.repository");
		activeStubs.push(stubMethod(episodes.episodesRepository, "findByPrimaryId", () => Promise.resolve(undefined)));

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[{ filePath: "/media/show/Season 01/s01e01.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-404" }],
		);

		expect(calls).toEqual([]);
	});

	test("threads the library flavor into the writer and exports artwork beside the documents", async () => {
		const { calls, writer } = recordingWriter();
		const artwork = recordingArtwork();

		await new SidecarMetadataStorageService(writer, artwork).saveLibraryMedia(
			{
				metadataStorageMode: "sidecar",
				sidecarFlavor: "kodi",
				paths: [{ path: "/media", metadataStorageMode: null }],
			},
			[{ filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null }],
		);

		expect(calls).toEqual(["movie:metadata-1:/media/movie:kodi"]);
		expect(artwork.calls).toEqual([`title:metadata-1:/media/movie`]);
	});

	test("defaults the flavor to reelvault for libraries predating the field", async () => {
		const { calls, writer } = recordingWriter();

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[{ filePath: "/media/movie/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null }],
		);

		expect(calls).toEqual(["movie:metadata-1:/media/movie:reelvault"]);
	});
});
