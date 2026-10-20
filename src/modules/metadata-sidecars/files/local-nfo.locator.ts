import { basename, dirname, join } from "node:path";
import { seasonFileName } from "@/modules/metadata-sidecars/saver/sidecar-path.policy";
import { fileExists } from "@/utils/file.utils";
import { getFileNameWithoutExt } from "@/utils/path.utils";
import { readSeasonNumber } from "./local-season.utils";

export interface LocalNfoChain {
	readonly movieDocument?: string | undefined;
	readonly seriesDocument?: string | undefined;
	readonly seasonDocument?: string | undefined;
	readonly episodeDocument?: string | undefined;
}

const MAX_SERIES_LOOKUP_DEPTH = 3;

/**
 * Finds the NFO documents describing a video file, mirroring the Jellyfin
 * layout: `<basename>.nfo` / `movie.nfo` next to a film; `<basename>.nfo`,
 * `seasonNN.nfo` and the nearest parent `tvshow.nfo` for an episode. The app's
 * own `<name>.reelvault.nfo` snapshots (default sidecar flavor) are read as a
 * fallback when no standard document exists. All candidates are optional — a
 * file without sidecars yields an empty chain.
 */
export async function locateLocalNfoChain(videoPath: string, kind: "movie" | "tv_show"): Promise<LocalNfoChain> {
	const directory = dirname(videoPath);
	const baseName = getFileNameWithoutExt(videoPath);
	const lowerBaseName = baseName.toLowerCase();

	if (kind === "movie") {
		return {
			movieDocument: await firstExisting([
				join(directory, `${baseName}.nfo`),
				join(directory, `${lowerBaseName}.nfo`),
				join(directory, "movie.nfo"),
				join(directory, `${baseName}.reelvault.nfo`),
				join(directory, `${lowerBaseName}.reelvault.nfo`),
				join(directory, "movie.reelvault.nfo"),
			]),
		};
	}

	const seasonNumber = readSeasonNumber(basename(directory));
	const paddedSeasonName = seasonNumber === undefined ? undefined : seasonFileName(seasonNumber, ".nfo");
	const paddedReelvaultSeasonName = seasonNumber === undefined ? undefined : seasonFileName(seasonNumber, "-reelvault.nfo");

	return {
		episodeDocument: await firstExisting([
			join(directory, `${baseName}.nfo`),
			join(directory, `${lowerBaseName}.nfo`),
			join(directory, `${baseName}.reelvault.nfo`),
			join(directory, `${lowerBaseName}.reelvault.nfo`),
		]),
		seasonDocument: await firstExisting([
			...(paddedSeasonName ? [join(directory, paddedSeasonName)] : []),
			join(directory, "season.nfo"),
			...(paddedReelvaultSeasonName ? [join(directory, paddedReelvaultSeasonName)] : []),
		]),
		seriesDocument: await findUpwards(directory, ["tvshow.nfo", "tvshow.reelvault.nfo"]),
	};
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await fileExists(candidate)) return candidate;
	}

	return undefined;
}

/** Nearest ancestor directory containing any of `fileNames` (first name wins per level). */
async function findUpwards(startDirectory: string, fileNames: readonly string[]): Promise<string | undefined> {
	let directory = startDirectory;
	for (let depth = 0; depth < MAX_SERIES_LOOKUP_DEPTH; depth++) {
		for (const fileName of fileNames) {
			const candidate = join(directory, fileName);
			if (await fileExists(candidate)) return candidate;
		}

		const parent = dirname(directory);
		if (parent === directory) return undefined;

		directory = parent;
	}

	return undefined;
}
