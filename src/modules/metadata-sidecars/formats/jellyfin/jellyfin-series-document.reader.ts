import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { extractYear } from "../../sidecar-metadata.utils";
import { readXmlObject, readXmlText } from "../../xml/xml-value.reader";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";
import { loadJellyfinDocument, toDetailFields, toIdentifiers } from "./jellyfin-common";

export async function readJellyfinSeriesDocument({ documentPath, content }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	const document = await loadJellyfinDocument(documentPath, content);
	const series = document ? readXmlObject(document, "tvshow") : undefined;
	if (!series) return null;

	return {
		mediaKind: "series",
		identifiers: toIdentifiers(series),
		title: readXmlText(series, "title"),
		originalTitle: readXmlText(series, "originaltitle"),
		year: extractYear(readXmlText(series, "year")),
		releaseDate: readXmlText(series, "premiered"),
		overview: readXmlText(series, "plot"),
		status: readXmlText(series, "status"),
		...toDetailFields(series),
		artwork: mapJellyfinArtwork(documentPath, series),
	};
}
