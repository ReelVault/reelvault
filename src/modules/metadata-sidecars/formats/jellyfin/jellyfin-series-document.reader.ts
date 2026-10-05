import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readTitleDocument } from "./jellyfin-common";

export async function readJellyfinSeriesDocument(input: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(input, { root: "tvshow", mediaKind: "series", releaseDateElement: "premiered" });
}
