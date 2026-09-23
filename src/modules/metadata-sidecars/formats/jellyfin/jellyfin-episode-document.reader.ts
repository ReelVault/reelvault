import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readXmlObject, readXmlText } from "../../xml/xml-value.reader";
import { mapJellyfinArtwork } from "./jellyfin-artwork.mapper";
import { loadJellyfinDocument, toIdentifiers } from "./jellyfin-common";

export async function readJellyfinEpisodeDocument({ documentPath, content }: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	const document = await loadJellyfinDocument(documentPath, content);
	const episode = document ? readXmlObject(document, "episodedetails") : undefined;
	if (!episode) return null;

	// Episode artwork rides the shared mapper: Jellyfin's `<art><poster>` (the
	// `-thumb.jpg` file), Kodi's bare `<thumb>`, Plex's `<thumb aspect="poster">`.
	const thumbnail = mapJellyfinArtwork(documentPath, episode).poster;

	return {
		mediaKind: "episode",
		identifiers: toIdentifiers(episode),
		title: readXmlText(episode, "title"),
		releaseDate: readXmlText(episode, "aired"),
		overview: readXmlText(episode, "plot"),
		artwork: { thumbnail },
	};
}
