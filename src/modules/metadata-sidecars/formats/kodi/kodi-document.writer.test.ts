import { describe, expect, test } from "bun:test";
import type { SidecarSnapshotDocument } from "../../sidecar.types";
import { buildKodiDocument } from "./kodi-document.writer";

function snapshot(overrides: Partial<SidecarSnapshotDocument> = {}): SidecarSnapshotDocument {
	return {
		reelvaultSchemaVersion: 1,
		title: "Arrival",
		releaseDate: "2016-11-10",
		year: 2016,
		identifiers: { imdb: "tt2543164", tmdb: "329865" },
		providerIds: {},
		genres: ["Sci-Fi", "Dramat"],
		keywords: ["first contact"],
		productionCompanies: ["Paramount"],
		cast: [{ name: "Amy Adams", character: "Louise Banks", order: 0 }],
		crew: [
			{ name: "Denis Villeneuve", job: "Director" },
			{ name: "Eric Heisserer", job: "Screenplay" },
			{ name: "Ted Chiang", job: "Story" },
			{ name: "Someone Else", job: "Producer" },
		],
		ratings: [
			{ source: "imdb", value: 7.9, voteCount: 700000 },
			{ source: "tmdb", value: 7.6 },
		],
		...overrides,
	};
}

describe("buildKodiDocument", () => {
	test("builds a <movie> with ids, detail fields, crew and attributed ratings", () => {
		const { rootName, values } = buildKodiDocument("/media/Movie/movie.nfo", snapshot());

		expect(rootName).toBe("movie");
		expect(values).toMatchObject({
			title: "Arrival",
			premiered: "2016-11-10",
			year: 2016,
			imdbid: "tt2543164",
			id: "tt2543164",
			tmdbid: "329865",
			uniqueid: [
				{ "@_type": "imdb", "#text": "tt2543164" },
				{ "@_type": "tmdb", "@_default": "true", "#text": "329865" },
			],
			genre: ["Sci-Fi", "Dramat"],
			tag: ["first contact"],
			studio: ["Paramount"],
			actor: [{ name: "Amy Adams", role: "Louise Banks", order: 0 }],
			director: ["Denis Villeneuve"],
			credits: ["Eric Heisserer", "Ted Chiang"],
			ratings: {
				rating: [
					{ "@_name": "imdb", "@_max": "10", "@_default": "true", value: "7.9", votes: "700000" },
					{ "@_name": "tmdb", "@_max": "10", value: "7.6" },
				],
			},
		});
		expect(values).not.toHaveProperty("season");
	});

	test("builds <tvshow>, <season> and <episodedetails> roots from the file names", () => {
		expect(buildKodiDocument("/media/Show/tvshow.nfo", snapshot()).rootName).toBe("tvshow");
		expect(buildKodiDocument("/media/Show/season03.nfo", snapshot()).rootName).toBe("season");
		expect(buildKodiDocument("/media/Show/s03e01.nfo", snapshot()).rootName).toBe("episodedetails");
	});

	test("season documents carry the season number", () => {
		const season = buildKodiDocument("/media/Show/season03.nfo", snapshot({ seasonNumber: 3 }));

		expect(season.values).toMatchObject({ seasonnumber: 3 });
	});

	test("episode documents carry placement numbers and the aired date", () => {
		const episode = buildKodiDocument("/media/Show/s01e01.nfo", snapshot({ seasonNumber: 1, episodeNumber: 1 }));

		expect(episode.values).toMatchObject({ season: 1, episode: 1, aired: "2016-11-10" });
		expect(episode.values).not.toHaveProperty("premiered");
	});

	test("marks the tmdb unique id as default regardless of map order", () => {
		const { values } = buildKodiDocument(
			"/media/Movie/movie.nfo",
			snapshot({ identifiers: { tvdb: "121361", imdb: "tt2543164", tmdb: "329865" } }),
		);

		expect(values.uniqueid).toMatchObject([{ "@_type": "tvdb" }, { "@_type": "imdb" }, { "@_type": "tmdb", "@_default": "true" }]);
	});
});
