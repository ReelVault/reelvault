import type { ExternalIdentifiers } from "@reelvault/sdk/plugin";
import { FileUtils, readFile } from "@/utils/file.utils";
import type { CanonicalSidecarDocument, SidecarArtwork, SidecarFormatInput } from "../../sidecar.types";
import { extractYear } from "../../sidecar-metadata.utils";
import { assertXmlDocumentSize, readXmlDocument, type XmlDocument } from "../../xml/xml-document.reader";
import { readXmlAttr, readXmlObject, readXmlObjects, readXmlText, readXmlTexts, readXmlValue } from "../../xml/xml-value.reader";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";

const IMDB_REGEX = /^tt\d+$/;
const NUMERIC_ID_REGEX = /^\d+$/;

/** Drops undefined/empty namespaces so the resulting identifier map only contains usable ids. */
export function toExternalIdentifiers(values: Record<string, string | undefined>): ExternalIdentifiers {
	const identifiers: Record<string, string> = {};
	for (const [namespace, value] of Object.entries(values)) {
		if (value) identifiers[namespace] = value;
	}

	return identifiers;
}

export function validImdb(value: string | undefined): string | undefined {
	return value && IMDB_REGEX.test(value) ? value : undefined;
}

export function validTmdb(value: string | undefined): string | undefined {
	return value && NUMERIC_ID_REGEX.test(value) ? value : undefined;
}

/**
 * Reads and parses a Jellyfin sidecar. When the caller already supplied the
 * document body the file is not read again, but the size cap is still enforced.
 */
export async function loadJellyfinDocument(documentPath: string, content: string | undefined): Promise<XmlDocument | null> {
	if (content === undefined) assertXmlDocumentSize(documentPath, FileUtils.getSize(documentPath));

	const input = content ?? (await readFile(documentPath, "utf8").catch(() => null));
	if (input === null) return null;

	return readXmlDocument(input);
}

function readUniqueId(node: Readonly<Record<string, unknown>>, type: string): string | undefined {
	for (const uniqueId of readXmlObjects(node, "uniqueid")) {
		if (readXmlAttr(uniqueId, "type") === type) return readXmlValue(uniqueId);
	}

	return undefined;
}

/** Kodi's legacy `<id>`: typed via `moviedb="…"` or an imdb tt-number. Bare
 * digits are ambiguous (tvdb in Kodi shows, tmdb elsewhere) and are skipped. */
function readLegacyId(node: Readonly<Record<string, unknown>>, namespace: "imdb" | "tmdb" | "tvdb"): string | undefined {
	const value = readXmlText(node, "id");
	if (!value) return undefined;

	if (readXmlObjects(node, "id").some((element) => readXmlAttr(element, "moviedb") === namespace)) return value;

	return namespace === "imdb" && IMDB_REGEX.test(value) ? value : undefined;
}

/** imdb/tmdb/tvdb identifiers from a `<movie>`/`<tvshow>`/`<season>`/`<episodedetails>` element,
 * covering the Kodi/Plex `<uniqueid type="…">` form and Jellyfin's flat elements. */
export function toIdentifiers(node: Readonly<Record<string, unknown>>): ExternalIdentifiers {
	return toExternalIdentifiers({
		imdb: validImdb(
			readUniqueId(node, "imdb") ?? readXmlText(node, "imdbid") ?? readXmlText(node, "imdb_id") ?? readLegacyId(node, "imdb"),
		),
		tmdb: validTmdb(readUniqueId(node, "tmdb") ?? readXmlText(node, "tmdbid") ?? readLegacyId(node, "tmdb")),
		tvdb: validTmdb(readUniqueId(node, "tvdb") ?? readXmlText(node, "tvdbid") ?? readLegacyId(node, "tvdb")),
	});
}

const NUMBER_REGEX = /^\d+(\.\d+)?$/;

/** Numeric text (runtime minutes, rating values). */
export function toNumber(value: string | undefined): number | undefined {
	return value && NUMBER_REGEX.test(value) ? Number(value) : undefined;
}

interface DetailFields {
	readonly genres?: readonly string[];
	readonly cast?: ReadonlyArray<{ name: string; character?: string; order?: number }>;
	readonly ratings?: ReadonlyArray<{ source: string; value: number; voteCount?: number }>;
	readonly runtimeMinutes?: number;
}

/** Rating elements live under the root (Jellyfin) or inside a `<ratings>` wrapper (Kodi/Plex). */
function readRatingElements(node: Readonly<Record<string, unknown>>): ReadonlyArray<Readonly<Record<string, unknown>>> {
	return [...readXmlObjects(node, "rating"), ...readXmlObjects(node, "ratings").flatMap((wrapper) => readXmlObjects(wrapper, "rating"))];
}

/**
 * Library-quality fields shared by the `<movie>`/`<tvshow>` readers: genres,
 * cast (`<actor>`), ratings (`<rating>` in all dialects) and runtime.
 */
export function toDetailFields(node: Readonly<Record<string, unknown>>): DetailFields {
	const genres = readXmlTexts(node, "genre");
	const cast: Array<{ name: string; character?: string; order?: number }> = [];
	readXmlObjects(node, "actor").forEach((actor, index) => {
		const name = readXmlText(actor, "name");
		if (!name) return;

		// Jellyfin packs crew into `<actor>` blocks (job in `<role>`, e.g.
		// `<type>Producer</type>`) — only performers belong in the cast.
		const type = readXmlText(actor, "type")?.toLowerCase();
		if (type !== undefined && type !== "actor" && type !== "gueststar") return;

		const character = readXmlText(actor, "role");
		const order = toNumber(readXmlText(actor, "order")) ?? toNumber(readXmlText(actor, "sortorder")) ?? index;
		cast.push({ name, ...(character !== undefined ? { character } : {}), order });
	});
	const ratings: Array<{ source: string; value: number; voteCount?: number }> = [];
	for (const rating of readRatingElements(node)) {
		const value = toNumber(readXmlText(rating, "value")) ?? toNumber(readXmlValue(rating));
		if (value === undefined) continue;

		const voteCount = toNumber(readXmlText(rating, "votes"));
		ratings.push({
			source: readXmlAttr(rating, "name") ?? readXmlText(rating, "name") ?? "sidecar",
			value,
			...(voteCount !== undefined ? { voteCount } : {}),
		});
	}

	if (ratings.length === 0) {
		// Jellyfin's own `<rating>7.066</rating>` — plain text, no source element.
		const bareRating = toNumber(readXmlText(node, "rating"));
		if (bareRating !== undefined) ratings.push({ source: "sidecar", value: bareRating });
	}

	const runtimeMinutes = toNumber(readXmlText(node, "runtime")) ?? toNumber(readXmlText(node, "minutes"));

	return {
		...(genres.length > 0 ? { genres } : {}),
		...(cast.length > 0 ? { cast } : {}),
		...(ratings.length > 0 ? { ratings } : {}),
		...(runtimeMinutes !== undefined ? { runtimeMinutes } : {}),
	};
}

interface JellyfinTitleDocumentOptions {
	readonly root: string;
	readonly mediaKind: CanonicalSidecarDocument["mediaKind"];
	/** Release-date element(s) in priority order (season: `premiered ?? aired`). */
	readonly releaseDateElement: string | readonly string[];
	readonly withTagline?: boolean | undefined;
}

/**
 * Canonical document shared by the `<movie>`/`<tvshow>`/`<season>`/`<episodedetails>`
 * roots. `mediaKind` also selects the mapped field set: movie/series carry the
 * title-level details, season/episode only the reduced artwork their dialect supports.
 */
export async function readTitleDocument(
	{ documentPath, content }: SidecarFormatInput,
	{ root, mediaKind, releaseDateElement, withTagline = false }: JellyfinTitleDocumentOptions,
	/** Parsed once by callers that try several roots (the format adapter). */
	preloaded?: XmlDocument | null,
): Promise<CanonicalSidecarDocument | null> {
	const document = preloaded === undefined ? await loadJellyfinDocument(documentPath, content) : preloaded;
	const node = document ? readXmlObject(document, root) : undefined;
	if (!node) return null;

	const titleLevel = mediaKind === "movie" || mediaKind === "series";

	return {
		mediaKind,
		identifiers: toIdentifiers(node),
		title: readXmlText(node, "title"),
		...(titleLevel
			? {
					originalTitle: readXmlText(node, "originaltitle"),
					year: extractYear(readXmlText(node, "year")),
					status: readXmlText(node, "status"),
					...toDetailFields(node),
				}
			: {}),
		releaseDate: readReleaseDate(node, releaseDateElement),
		overview: readXmlText(node, "plot"),
		...(withTagline ? { tagline: readXmlText(node, "tagline") } : {}),
		artwork: mapTitleArtwork(mediaKind, documentPath, node),
	};
}

/** `premiered ?? aired` for seasons; a single element for the other roots. */
function readReleaseDate(node: Readonly<Record<string, unknown>>, elements: string | readonly string[]): string | undefined {
	for (const element of typeof elements === "string" ? [elements] : elements) {
		const value = readXmlText(node, element);
		if (value !== undefined) return value;
	}

	return undefined;
}

/** Season/episode documents carry a single local image, movie/series the full art set. */
function mapTitleArtwork(
	mediaKind: CanonicalSidecarDocument["mediaKind"],
	documentPath: string,
	node: Readonly<Record<string, unknown>>,
): SidecarArtwork {
	const artwork = mapJellyfinArtwork(documentPath, node);
	if (mediaKind === "season") return { poster: artwork.poster };
	if (mediaKind === "episode") return { thumbnail: artwork.poster };

	return artwork;
}
