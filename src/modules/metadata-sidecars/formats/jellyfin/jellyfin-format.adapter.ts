import { readFile } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import type { SidecarFormatInput } from "../../sidecar.types";
import type { SidecarFormatAdapter } from "../sidecar-format.adapter";
import { loadJellyfinDocument } from "./jellyfin-common";
import { readJellyfinEpisodeDocument } from "./jellyfin-episode-document.reader";
import { readJellyfinMovieDocument } from "./jellyfin-movie-document.reader";
import { readJellyfinSeasonDocument } from "./jellyfin-season-document.reader";
import { readJellyfinSeriesDocument } from "./jellyfin-series-document.reader";

export class JellyfinFormatAdapter implements SidecarFormatAdapter {
	readonly id = "jellyfin";
	readonly capabilities = ["read"] as const;

	canRead({ documentPath }: SidecarFormatInput): Promise<boolean> {
		return Promise.resolve(PathUtils.getFileName(documentPath).toLowerCase().endsWith(".nfo"));
	}

	async read(input: SidecarFormatInput) {
		const content = input.content ?? (await readFile(input.documentPath, "utf8").catch(() => null));
		if (content === null) return null;

		// Validate and parse once, then pick the root. Each candidate reader used
		// to re-validate and re-parse the same document — 4x for an episode NFO.
		const document = await loadJellyfinDocument(input.documentPath, content);
		if (!document) return null;

		return (
			(await readJellyfinMovieDocument({ ...input, content }, document)) ??
			(await readJellyfinSeriesDocument({ ...input, content }, document)) ??
			(await readJellyfinSeasonDocument({ ...input, content }, document)) ??
			(await readJellyfinEpisodeDocument({ ...input, content }, document))
		);
	}
}
