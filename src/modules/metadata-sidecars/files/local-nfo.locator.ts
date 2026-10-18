import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
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
	const directory = PathUtils.getDirName(videoPath);
	const baseName = PathUtils.getFileNameWithoutExt(videoPath);
	const lowerBaseName = baseName.toLowerCase();

	if (kind === "movie") {
		return {
			movieDocument: await firstExisting([
				PathUtils.join(directory, `${baseName}.nfo`),
				PathUtils.join(directory, `${lowerBaseName}.nfo`),
				PathUtils.join(directory, "movie.nfo"),
				PathUtils.join(directory, `${baseName}.reelvault.nfo`),
				PathUtils.join(directory, `${lowerBaseName}.reelvault.nfo`),
				PathUtils.join(directory, "movie.reelvault.nfo"),
			]),
		};
	}

	const seasonNumber = readSeasonNumber(PathUtils.getFileName(directory));
	const paddedSeasonName = seasonNumber === undefined ? undefined : `season${String(seasonNumber).padStart(2, "0")}.nfo`;
	const paddedReelvaultSeasonName = seasonNumber === undefined ? undefined : `season${String(seasonNumber).padStart(2, "0")}-reelvault.nfo`;

	return {
		episodeDocument: await firstExisting([
			PathUtils.join(directory, `${baseName}.nfo`),
			PathUtils.join(directory, `${lowerBaseName}.nfo`),
			PathUtils.join(directory, `${baseName}.reelvault.nfo`),
			PathUtils.join(directory, `${lowerBaseName}.reelvault.nfo`),
		]),
		seasonDocument: await firstExisting([
			...(paddedSeasonName ? [PathUtils.join(directory, paddedSeasonName)] : []),
			PathUtils.join(directory, "season.nfo"),
			...(paddedReelvaultSeasonName ? [PathUtils.join(directory, paddedReelvaultSeasonName)] : []),
		]),
		seriesDocument: await findUpwards(directory, ["tvshow.nfo", "tvshow.reelvault.nfo"]),
	};
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await FileUtils.exists(candidate)) return candidate;
	}

	return undefined;
}

/** Nearest ancestor directory containing any of `fileNames` (first name wins per level). */
async function findUpwards(startDirectory: string, fileNames: readonly string[]): Promise<string | undefined> {
	let directory = startDirectory;
	for (let depth = 0; depth < MAX_SERIES_LOOKUP_DEPTH; depth++) {
		for (const fileName of fileNames) {
			const candidate = PathUtils.join(directory, fileName);
			if (await FileUtils.exists(candidate)) return candidate;
		}

		const parent = PathUtils.getDirName(directory);
		if (parent === directory) return undefined;

		directory = parent;
	}

	return undefined;
}
