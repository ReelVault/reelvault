import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

export interface LocalNfoChain {
	readonly movieDocument?: string | undefined;
	readonly seriesDocument?: string | undefined;
	readonly seasonDocument?: string | undefined;
	readonly episodeDocument?: string | undefined;
}

const SEASON_DIR_REGEX = /season\s*(\d{1,2})/i;
const MAX_SERIES_LOOKUP_DEPTH = 3;

/**
 * Finds the NFO documents describing a video file, mirroring the Jellyfin
 * layout: `<basename>.nfo` / `movie.nfo` next to a film; `<basename>.nfo`,
 * `seasonNN.nfo` and the nearest parent `tvshow.nfo` for an episode. All
 * candidates are optional — a file without sidecars yields an empty chain.
 */
export async function locateLocalNfoChain(videoPath: string, kind: "movie" | "tv_show"): Promise<LocalNfoChain> {
	const directory = PathUtils.getDirName(videoPath);
	const baseName = PathUtils.getFileNameWithoutExt(videoPath);

	if (kind === "movie") {
		return {
			movieDocument: await firstExisting([
				PathUtils.join(directory, `${baseName}.nfo`),
				PathUtils.join(directory, `${baseName.toLowerCase()}.nfo`),
				PathUtils.join(directory, "movie.nfo"),
			]),
		};
	}

	const seasonNumber = readSeasonNumber(PathUtils.getFileName(directory));
	const paddedSeasonName = seasonNumber === undefined ? undefined : `season${String(seasonNumber).padStart(2, "0")}.nfo`;

	return {
		episodeDocument: await firstExisting([
			PathUtils.join(directory, `${baseName}.nfo`),
			PathUtils.join(directory, `${baseName.toLowerCase()}.nfo`),
		]),
		seasonDocument: await firstExisting([
			...(paddedSeasonName ? [PathUtils.join(directory, paddedSeasonName)] : []),
			PathUtils.join(directory, "season.nfo"),
		]),
		seriesDocument: await findUpwards(directory, "tvshow.nfo"),
	};
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await FileUtils.exists(candidate)) return candidate;
	}

	return undefined;
}

async function findUpwards(startDirectory: string, fileName: string): Promise<string | undefined> {
	let directory = startDirectory;
	for (let depth = 0; depth < MAX_SERIES_LOOKUP_DEPTH; depth++) {
		const candidate = PathUtils.join(directory, fileName);
		if (await FileUtils.exists(candidate)) return candidate;

		const parent = PathUtils.getDirName(directory);
		if (parent === directory) return undefined;

		directory = parent;
	}

	return undefined;
}

function readSeasonNumber(name: string): number | undefined {
	const match = SEASON_DIR_REGEX.exec(name);

	return match ? Number(match[1]) : undefined;
}
