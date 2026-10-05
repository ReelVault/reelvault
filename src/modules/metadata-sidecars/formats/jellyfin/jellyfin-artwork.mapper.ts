import { PathUtils } from "@/utils/path.utils";
import type { SidecarArtwork } from "../../sidecar.types";
import { readXmlAttr, readXmlChildObject, readXmlObjects, readXmlText, readXmlTexts, readXmlValue } from "../../xml/xml-value.reader";

const REMOTE_URL_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;

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

/** Resolves a sibling artwork reference, refusing escaping paths. Absolute
 * values (Jellyfin exports carry the source server's paths) are re-anchored to
 * the file name inside the document's own directory. Remote URLs have no local
 * counterpart and are rejected instead of resolving to a garbage subpath. */
export function resolveLocalArtworkPath(documentPath: string, value: string | undefined): { path: string } | undefined {
	if (!value || REMOTE_URL_REGEX.test(value)) return undefined;

	const directory = PathUtils.getDirName(documentPath);
	const candidate = PathUtils.isAbsolute(value)
		? PathUtils.join(directory, PathUtils.getFileName(value))
		: PathUtils.resolve(directory, value);
	if (!PathUtils.isSubpath(candidate, directory)) return undefined;

	return { path: candidate };
}
