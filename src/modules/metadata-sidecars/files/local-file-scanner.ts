import { readdir } from "node:fs/promises";
import { EPISODE_SXXEXX_PATTERN } from "@/modules/recognition/utils/recognition.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { isNotNullish } from "@/utils/array.utils";
import { errorMessage, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import type { SidecarArtworkReference } from "../sidecar.types";
import { indexByLowerCaseName, selectEpisodeThumbnail, selectIgnoredAssets, selectMovieArtwork } from "./local-artwork-selector";
import type { LocalEpisodeFile, LocalMovieFolder, LocalSeasonGroup, LocalSeriesGroup } from "./local-media-grouping";

const logger = createLogger("LocalFileScanner");
const SEASON_NUMBER_REGEX = /season\s*(\d{1,2})/i;

interface LocalFileScanner {
	inspectMovie(videoPath: string): Promise<LocalMovieFolder>;
	inspectSeries(seriesPath: string): Promise<LocalSeriesGroup>;
}

export class FilesystemLocalFileScanner implements LocalFileScanner {
	private readonly libraryRoot: string;

	constructor(libraryRoot: string) {
		this.libraryRoot = libraryRoot;
	}

	async inspectMovie(videoPath: string): Promise<LocalMovieFolder> {
		this.assertWithinRoot(videoPath);
		const movieDirectory = PathUtils.getDirName(videoPath);
		const files = await readFiles(movieDirectory);
		const index = indexByLowerCaseName(files);

		return {
			movieDirectory,
			videoPaths: files.filter((path) => PathUtils.isVideoFile(path)),
			documentPath: index.get("movie.nfo"),
			artwork: selectMovieArtwork(index),
			ignoredAssets: selectIgnoredAssets(files),
		};
	}

	async inspectSeries(seriesPath: string): Promise<LocalSeriesGroup> {
		this.assertWithinRoot(seriesPath);
		const seriesDirectory = PathUtils.resolve(seriesPath);
		const entries = await readdir(seriesDirectory, { withFileTypes: true }).catch((error) => {
			// An unreadable series directory (EACCES on a NAS mount) must be
			// distinguishable from an empty one — otherwise sidecar metadata
			// silently vanishes.
			logger.warn("Series directory unreadable — treated as empty", { seriesDirectory, error: errorMessage(error) });

			return null;
		});
		if (!entries) {
			return {
				seriesDirectory,
				seasonGroups: [],
				artwork: {},
			};
		}

		const files: string[] = [];
		const directories: string[] = [];
		for (const e of entries) {
			const fullPath = PathUtils.join(seriesDirectory, e.name);
			if (e.isFile()) files.push(fullPath);
			else if (e.isDirectory()) directories.push(fullPath);
		}

		const index = indexByLowerCaseName(files);
		const seasonGroups = await PromiseUtils.mapConcurrent(
			directories,
			systemResourcesService.getIoConcurrency(),
			async (directory) => await this.inspectSeason(directory),
		);

		return {
			seriesDirectory,
			seriesDocument: index.get("tvshow.nfo"),
			seasonGroups: seasonGroups.filter((item) => isNotNullish(item)),
			artwork: selectMovieArtwork(index),
		};
	}

	private async inspectSeason(directory: string): Promise<LocalSeasonGroup | null> {
		const seasonNumber = readSeasonNumber(PathUtils.getFileName(directory));
		if (seasonNumber === undefined) return null;

		const files = await readFiles(directory);
		const index = indexByLowerCaseName(files);
		const episodeFiles: LocalEpisodeFile[] = [];
		for (const path of files) {
			if (PathUtils.isVideoFile(path)) episodeFiles.push(toEpisodeFile(path, index));
		}

		return {
			seasonNumber,
			seasonDocument: index.get(`season${String(seasonNumber).padStart(2, "0")}.nfo`),
			poster: findSeasonPoster(seasonNumber, index),
			episodes: episodeFiles,
		};
	}

	private assertWithinRoot(path: string): void {
		if (!PathUtils.isSubpath(path, this.libraryRoot)) {
			throw new ValidationError(`Sidecar path must be inside configured library root: ${PathUtils.resolve(path)}`);
		}
	}
}

async function readFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
		logger.warn("Directory unreadable — treated as empty", { directory, error: errorMessage(error) });

		return null;
	});
	if (!entries) return [];

	const result: string[] = [];
	for (const entry of entries) {
		if (entry.isFile()) result.push(PathUtils.join(directory, entry.name));
	}

	return result;
}

function readSeasonNumber(name: string): number | undefined {
	const match = SEASON_NUMBER_REGEX.exec(name);

	return match ? Number(match[1]) : undefined;
}

function toEpisodeFile(videoPath: string, index: ReadonlyMap<string, string>): LocalEpisodeFile {
	const name = PathUtils.getFileNameWithoutExt(videoPath);
	const episodeNumber = EPISODE_SXXEXX_PATTERN.exec(name)?.[2];

	return {
		videoPath,
		episodeNumber: episodeNumber ? Number(episodeNumber) : undefined,
		documentPath: index.get(`${name}.nfo`.toLowerCase()),
		thumbnail: selectEpisodeThumbnail(videoPath, index),
	};
}

function findSeasonPoster(seasonNumber: number, index: ReadonlyMap<string, string>): SidecarArtworkReference | undefined {
	const name = `season${String(seasonNumber).padStart(2, "0")}-poster.jpg`;
	const path = index.get(name) ?? index.get("folder.jpg");

	return path ? { path } : undefined;
}
