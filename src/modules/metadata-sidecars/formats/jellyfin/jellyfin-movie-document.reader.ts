import type { CanonicalSidecarDocument, SidecarFormatInput } from "@/modules/metadata-sidecars/sidecar.types";
import type { XmlDocument } from "@/modules/metadata-sidecars/xml/xml-document.reader";
import { readTitleDocument } from "./jellyfin-common.utils";

export async function readJellyfinMovieDocument(
	input: SidecarFormatInput,
	document?: XmlDocument | null,
): Promise<CanonicalSidecarDocument | null> {
	return await readTitleDocument(
		input,
		{ root: "movie", mediaKind: "movie", releaseDateElement: "premiered", withTagline: true },
		document,
	);
}
