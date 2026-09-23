import { PathUtils } from "@/utils/path.utils";
import type { SidecarRating, SidecarSnapshotDocument } from "../../sidecar.types";
import type { XmlDocumentOutput } from "../../xml/xml-writer";

const SEASON_FILE_REGEX = /^season\d*\.nfo$/;

/** The root element follows the file name — same inference the reelvault adapter does. */
export function buildKodiDocument(documentPath: string, document: SidecarSnapshotDocument): XmlDocumentOutput {
	const name = PathUtils.getFileName(documentPath).toLowerCase();
	if (name === "movie.nfo") return { rootName: "movie", values: { ...toTitleFields(document), ...premieredField(document) } };

	if (name === "tvshow.nfo") return { rootName: "tvshow", values: { ...toTitleFields(document), ...premieredField(document) } };

	if (SEASON_FILE_REGEX.test(name)) {
		return {
			rootName: "season",
			values: {
				...toTitleFields(document),
				...premieredField(document),
				...(document.seasonNumber !== undefined ? { seasonnumber: document.seasonNumber } : {}),
			},
		};
	}

	return {
		rootName: "episodedetails",
		values: {
			...toTitleFields(document),
			// Episodes date with `<aired>`; `<premiered>` belongs to titles.
			...(document.releaseDate !== undefined ? { aired: document.releaseDate } : {}),
			...(document.seasonNumber !== undefined ? { season: document.seasonNumber } : {}),
			...(document.episodeNumber !== undefined ? { episode: document.episodeNumber } : {}),
		},
	};
}

function premieredField(document: SidecarSnapshotDocument): Record<string, unknown> {
	return document.releaseDate !== undefined ? { premiered: document.releaseDate } : {};
}

const UNIQUE_ID_PRIORITY = ["tmdb", "imdb", "tvdb"] as const;
const CREDITS_JOBS = new Set(["writer", "screenplay", "story"]);

function toTitleFields(document: SidecarSnapshotDocument): Record<string, unknown> {
	const values: Record<string, unknown> = {
		title: document.title,
		...(document.originalTitle !== undefined ? { originaltitle: document.originalTitle } : {}),
		...(document.overview !== undefined ? { plot: document.overview } : {}),
		...(document.tagline !== undefined ? { tagline: document.tagline } : {}),
		...(document.year !== undefined ? { year: document.year } : {}),
		...(document.status !== undefined ? { status: document.status } : {}),
		...toUniqueIdFields(document.identifiers),
	};

	if (document.genres.length > 0) values.genre = [...document.genres];

	if (document.keywords.length > 0) values.tag = [...document.keywords];

	if (document.productionCompanies.length > 0) values.studio = [...document.productionCompanies];

	if (document.collection !== undefined) values.set = { name: document.collection };

	if (document.cast.length > 0) {
		values.actor = document.cast.map((member) => ({
			name: member.name,
			...(member.character !== undefined ? { role: member.character } : {}),
			...(member.order !== undefined ? { order: member.order } : {}),
		}));
	}

	const directors = document.crew.filter((member) => member.job.toLowerCase() === "director").map((member) => member.name);
	if (directors.length > 0) values.director = directors;

	const credits = document.crew.filter((member) => CREDITS_JOBS.has(member.job.toLowerCase())).map((member) => member.name);
	if (credits.length > 0) values.credits = credits;

	if (document.ratings.length > 0) values.ratings = { rating: document.ratings.map(toRatingValues) };

	return values;
}

function toUniqueIdFields(identifiers: SidecarSnapshotDocument["identifiers"]): Record<string, unknown> {
	const namespaces = Object.keys(identifiers);
	if (namespaces.length === 0) return {};

	const defaultNamespace = UNIQUE_ID_PRIORITY.find((namespace) => namespaces.includes(namespace)) ?? namespaces[0];
	const values: Record<string, unknown> = {
		uniqueid: namespaces.map((namespace) => ({
			"@_type": namespace,
			...(namespace === defaultNamespace ? { "@_default": "true" } : {}),
			"#text": identifiers[namespace],
		})),
	};
	// Flat legacy elements keep older Jellyfin versions and other tools reading the ids.
	if (identifiers.imdb) {
		values.imdbid = identifiers.imdb;
		values.id = identifiers.imdb;
	}

	if (identifiers.tmdb) values.tmdbid = identifiers.tmdb;

	if (identifiers.tvdb) values.tvdbid = identifiers.tvdb;

	return values;
}

/** Kodi/Plex ratings carry their source and scale as attributes; the first entry is the default. */
function toRatingValues(rating: SidecarRating, index: number): Record<string, unknown> {
	return {
		"@_name": rating.source,
		"@_max": "10",
		...(index === 0 ? { "@_default": "true" } : {}),
		value: String(rating.value),
		...(rating.voteCount !== undefined ? { votes: String(rating.voteCount) } : {}),
	};
}
