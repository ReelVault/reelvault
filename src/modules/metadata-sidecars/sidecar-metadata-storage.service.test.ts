import { afterEach, describe, expect, test } from "bun:test";
import { stubMethod } from "../../../tests/helpers/method-stub";
import type { SidecarArtworkWriter } from "./saver/sidecar-artwork.exporter";
import type { SidecarMetadataWriter } from "./sidecar.types";
import { SidecarMetadataStorageService } from "./sidecar-metadata-storage.service";

/** Replaces a method on the live singleton for one test.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */

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
			stubMethod(episodes.episodesRepository, "findRecordsByIds", ({ ids }: { ids: string[] }) =>
				Promise.resolve(
					ids.map((id) => ({
						id,
						seasonId: "season-1",
						title: "Dulcinea",
						episodeNumber: 1,
						airDate: null,
						overview: null,
						imageId: null,
					})),
				),
			),
			stubMethod(seasons.seasonsRepository, "findByIds", () =>
				Promise.resolve([
					{
						id: "season-1",
						seasonNumber: 1,
						name: "Season One",
						airDate: null,
						overview: null,
						status: null,
						imageId: null,
					},
				]),
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
		activeStubs.push(stubMethod(episodes.episodesRepository, "findRecordsByIds", () => Promise.resolve([])));

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[{ filePath: "/media/show/Season 01/s01e01.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-404" }],
		);

		expect(calls).toEqual([]);
	});

	test("resolves episodes and seasons with one batched lookup each", async () => {
		const { writer } = recordingWriter();
		const episodes = await import("@/database/repositories/episodes.repository");
		const seasons = await import("@/database/repositories/seasons.repository");
		const episodeLookups: string[][] = [];
		const seasonLookups: string[][] = [];
		activeStubs.push(
			stubMethod(episodes.episodesRepository, "findRecordsByIds", ({ ids }: { ids: string[] }) => {
				episodeLookups.push(ids);

				return Promise.resolve(
					ids.map((id) => ({
						id,
						seasonId: id.endsWith("1") ? "season-1" : "season-2",
						title: id,
						episodeNumber: 1,
						airDate: null,
						overview: null,
						imageId: null,
					})),
				);
			}),
			stubMethod(seasons.seasonsRepository, "findByIds", ({ ids }: { ids: string[] }) => {
				seasonLookups.push(ids);

				return Promise.resolve(
					ids.map((id) => ({
						id,
						seasonNumber: 1,
						name: id,
						airDate: null,
						overview: null,
						status: null,
						imageId: null,
					})),
				);
			}),
		);

		await new SidecarMetadataStorageService(writer, recordingArtwork()).saveLibraryMedia(
			{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
			[
				{ filePath: "/media/show/Season 01/s01e01.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-1" },
				{ filePath: "/media/show/Season 01/s01e02.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-2" },
				{ filePath: "/media/show/Season 02/s02e01.mkv", metadataId: "metadata-1", movieId: null, episodeId: "episode-3" },
			],
		);

		expect(episodeLookups).toHaveLength(1);
		expect(episodeLookups[0]?.toSorted()).toEqual(["episode-1", "episode-2", "episode-3"]);
		expect(seasonLookups).toHaveLength(1);
		expect(seasonLookups[0]?.toSorted()).toEqual(["season-1", "season-2"]);
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
