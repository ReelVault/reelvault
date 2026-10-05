import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readTitleDocument } from "./jellyfin-common";

export async function readJellyfinMovieDocument(input: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(input, { root: "movie", mediaKind: "movie", releaseDateElement: "premiered", withTagline: true });
}
