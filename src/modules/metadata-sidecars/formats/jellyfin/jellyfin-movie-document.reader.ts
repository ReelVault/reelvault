import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readXmlObject, readXmlText } from "../../xml/xml-value.reader";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";
import { loadJellyfinDocument, toDetailFields, toIdentifiers, toYear } from "./jellyfin-common";

export async function readJellyfinMovieDocument({ documentPath, content }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	const document = await loadJellyfinDocument(documentPath, content);
	const movie = document ? readXmlObject(document, "movie") : undefined;
	if (!movie) return null;

	return {
		mediaKind: "movie",
		identifiers: toIdentifiers(movie),
		title: readXmlText(movie, "title"),
		originalTitle: readXmlText(movie, "originaltitle"),
		year: toYear(readXmlText(movie, "year")),
		releaseDate: readXmlText(movie, "premiered"),
		overview: readXmlText(movie, "plot"),
		tagline: readXmlText(movie, "tagline"),
		status: readXmlText(movie, "status"),
		...toDetailFields(movie),
		artwork: mapJellyfinArtwork(documentPath, movie),
	};
}
