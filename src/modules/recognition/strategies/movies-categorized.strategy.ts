import type { PathContext, RecognitionResult, RecognitionStrategy } from "../recognition.types";
import { YEAR_FOLDER_PATTERN } from "../utils/recognition.constants";
import { parseFileName } from "../utils/recognition.utils";

const GENERIC_FOLDER_NAMES =
	/^(?:movies|filmy|film|cinema|kino|downloads|pobrane|video|wideo|media|temp|complete|4k|1080p|720p|bluray|uhd|remux)$/i;

export class MoviesCategorizedStrategy implements RecognitionStrategy {
	readonly name = "movies-categorized";

	recognize(ctx: PathContext): RecognitionResult | null {
		const { parentFolder, fileName, parts } = ctx;
		if (!(parentFolder && fileName) || parts.length < 2) return null;

		// If parent folder is generic (e.g. /movies/ or /filmy/), let MoviesBasicStrategy parse the filename
		if (GENERIC_FOLDER_NAMES.test(parentFolder.trim())) {
			return null;
		}

		const fileIdentity = parseFileName(fileName);

		if (YEAR_FOLDER_PATTERN.test(parentFolder)) {
			if (fileIdentity?.type === "movie") {
				return {
					type: "movie",
					identity: {
						...fileIdentity,
						year: fileIdentity.year ?? (Number.parseInt(parentFolder, 10) || undefined),
					},
					meta: {
						libraryStructure: this.name,
						rootPath: parentFolder,
					},
				};
			}
		}

		const folderIdentity = parseFileName(parentFolder);
		if (folderIdentity?.type !== "movie" && fileIdentity?.type !== "movie") return null;

		// Merge identities: prefer the most specific title and preserve any detected release year
		const year = fileIdentity?.year ?? folderIdentity?.year;
		let title = folderIdentity?.title ?? fileIdentity?.title ?? parentFolder;

		// If the file has an explicit year, its title is usually very clean (e.g. Iron.Man.2008.mkv -> "Iron Man")
		if (fileIdentity?.year && fileIdentity.title) {
			title = fileIdentity.title;
		} else if (folderIdentity?.year && folderIdentity.title) {
			title = folderIdentity.title;
		}

		return {
			type: "movie",
			identity: {
				title,
				type: "movie",
				year,
			},
			meta: {
				libraryStructure: this.name,
				rootPath: parentFolder,
			},
		};
	}
}
