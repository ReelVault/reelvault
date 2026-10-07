import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import type { XmlDocument } from "../../xml/xml-document.reader";
import { readTitleDocument } from "./jellyfin-common";

export async function readJellyfinEpisodeDocument(
	input: SidecarFormatInput,
	document?: XmlDocument | null,
): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(input, { root: "episodedetails", mediaKind: "episode", releaseDateElement: "aired" }, document);
}
