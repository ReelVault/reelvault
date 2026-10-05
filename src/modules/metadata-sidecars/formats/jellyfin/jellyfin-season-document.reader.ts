import type { CanonicalSidecarDocument, SidecarFormatInput } from "../../sidecar.types";
import { readTitleDocument } from "./jellyfin-common";

export async function readJellyfinSeasonDocument(input: SidecarFormatInput): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(input, { root: "season", mediaKind: "season", releaseDateElement: ["premiered", "aired"] });
}
