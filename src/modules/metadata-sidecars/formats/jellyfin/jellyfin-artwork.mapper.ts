import type { SidecarArtwork } from "../../sidecar.types";
import { readXmlAttr, readXmlChildObject, readXmlObjects, readXmlText, readXmlTexts, readXmlValue } from "../../xml/xml-value.reader";
import { resolveLocalArtworkPath } from "./jellyfin-common";

export function mapJellyfinArtwork(documentPath: string, values: Readonly<Record<string, unknown>>): SidecarArtwork {
	const art = readXmlChildObject(values, "art") ?? {};

	// Poster: Jellyfin's `<art><poster>`, Kodi/Plex's `<thumb aspect="poster">` or a bare `<thumb>`.
	// Backdrop: Jellyfin's `<art><fanart>`, Kodi/Plex's `<fanart><thumb>`.
	return {
		poster: resolveLocalArtworkPath(
			documentPath,
			readXmlText(art, "poster") ?? readAspectThumb(values, "poster") ?? readXmlText(values, "thumb"),
		),
		backdrop: resolveLocalArtworkPath(documentPath, readXmlText(art, "fanart") ?? readFanartThumb(values)),
	};
}

function readAspectThumb(values: Readonly<Record<string, unknown>>, aspect: string): string | undefined {
	for (const thumb of readXmlObjects(values, "thumb")) {
		if (readXmlAttr(thumb, "aspect") === aspect) return readXmlValue(thumb);
	}

	return undefined;
}

function readFanartThumb(values: Readonly<Record<string, unknown>>): string | undefined {
	return readXmlObjects(values, "fanart").flatMap((fanart) => readXmlTexts(fanart, "thumb"))[0];
}
