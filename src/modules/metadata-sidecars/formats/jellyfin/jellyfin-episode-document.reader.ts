import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readTitleDocument } from "./jellyfin-common";

export async function readJellyfinEpisodeDocument(input: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(input, { root: "episodedetails", mediaKind: "episode", releaseDateElement: "aired" });
}
