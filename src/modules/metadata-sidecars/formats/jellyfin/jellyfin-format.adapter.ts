import { basename } from "node:path";
import type { SidecarFormatAdapter } from "@/modules/metadata-sidecars/formats/sidecar-format.adapter";
import type { SidecarFormatInput } from "@/modules/metadata-sidecars/sidecar.types";
import { loadXmlDocumentFile, MAX_XML_DOCUMENT_BYTES } from "@/modules/metadata-sidecars/xml/xml-document.reader";
import { getFileStats, readFile } from "@/utils/file.utils";
import { readJellyfinEpisodeDocument } from "./jellyfin-episode-document.reader";
import { readJellyfinMovieDocument } from "./jellyfin-movie-document.reader";
import { readJellyfinSeasonDocument } from "./jellyfin-season-document.reader";
import { readJellyfinSeriesDocument } from "./jellyfin-series-document.reader";

export class JellyfinFormatAdapter implements SidecarFormatAdapter {
	readonly id = "jellyfin";
	readonly capabilities = ["read"] as const;

	canRead({ documentPath }: SidecarFormatInput): Promise<boolean> {
		const fileName = basename(documentPath).toLowerCase();

		// The app's own snapshots also end in `.nfo` — they must never be claimed
		// by the Jellyfin reader, or a registry-order change would break them.
		return Promise.resolve(fileName.endsWith(".nfo") && !fileName.endsWith(".reelvault.nfo"));
	}

	async read(input: SidecarFormatInput) {
		const content = input.content ?? (await readBoundedSidecarDocument(input.documentPath));
		if (content === null) return null;

		// Validate and parse once, then pick the root. Each candidate reader used
		// to re-validate and re-parse the same document — 4x for an episode NFO.
		const document = await loadXmlDocumentFile(input.documentPath, content);
		if (!document) return null;

		return (
			(await readJellyfinMovieDocument({ ...input, content }, document)) ??
			(await readJellyfinSeriesDocument({ ...input, content }, document)) ??
			(await readJellyfinSeasonDocument({ ...input, content }, document)) ??
			(await readJellyfinEpisodeDocument({ ...input, content }, document))
		);
	}
}

/** Stat before reading: the 2 MB cap must be enforced before a huge `.nfo` enters JS memory. */
async function readBoundedSidecarDocument(documentPath: string): Promise<string | null> {
	const stats = await getFileStats(documentPath);
	if (!stats || stats.size > MAX_XML_DOCUMENT_BYTES) return null;

	return await readFile(documentPath, "utf8").catch(() => null);
}
