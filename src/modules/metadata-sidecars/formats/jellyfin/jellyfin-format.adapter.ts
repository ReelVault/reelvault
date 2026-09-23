import { readFile } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import type { SidecarFormatInput } from "../../sidecar.types";
import type { SidecarFormatAdapter } from "../sidecar-format.adapter";
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

		return (
			(await readJellyfinMovieDocument({ ...input, content })) ??
			(await readJellyfinSeriesDocument({ ...input, content })) ??
			(await readJellyfinSeasonDocument({ ...input, content })) ??
			(await readJellyfinEpisodeDocument({ ...input, content }))
		);
	}
}
