import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readXmlObject, readXmlText } from "../../xml/xml-value.reader";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";
import { loadJellyfinDocument, toIdentifiers } from "./jellyfin-common";

export async function readJellyfinSeasonDocument({ documentPath, content }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	const document = await loadJellyfinDocument(documentPath, content);
	const season = document ? readXmlObject(document, "season") : undefined;
	if (!season) return null;

	return {
		mediaKind: "season",
		identifiers: toIdentifiers(season),
		title: readXmlText(season, "title"),
		releaseDate: readXmlText(season, "premiered") ?? readXmlText(season, "aired"),
		overview: readXmlText(season, "plot"),
		artwork: { poster: mapJellyfinArtwork(documentPath, season).poster },
	};
}
