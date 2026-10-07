import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { subtitleVttPath } from "./subtitle-path.utils";

interface SubtitleRowReference {
	type: string;
	filePath: string | null;
}

interface ServiceDependencies {
	deleteFile: (path: string) => Promise<boolean>;
	subtitlesPath: () => string;
}

const defaultDependencies: ServiceDependencies = {
	deleteFile: (path) => FileUtils.delete(path),
	subtitlesPath: () => serverConfig.paths.subtitles,
};

export class SubtitleFileCleaner extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SubtitleFileCleaner");
		this.dependencies = dependencies;
	}

	/** Drops only the extracted WebVTT cache for a subtitle — used when a row update invalidates its content. */
	async deleteExtractedVtt(subtitleId: string): Promise<void> {
		await this.dependencies.deleteFile(subtitleVttPath(this.dependencies.subtitlesPath(), subtitleId));
	}

	async deleteArtifacts(subtitleId: string, subtitle: SubtitleRowReference): Promise<void> {
		const subtitlesPath = this.dependencies.subtitlesPath();
		const deletions: Array<Promise<boolean>> = [this.dependencies.deleteFile(subtitleVttPath(subtitlesPath, subtitleId))];
		if (subtitle.type === "external" && subtitle.filePath && PathUtils.isSubpath(subtitle.filePath, subtitlesPath)) {
			deletions.push(this.dependencies.deleteFile(subtitle.filePath));
		}

		await Promise.all(deletions);
	}
}

export const subtitleFileCleaner = new SubtitleFileCleaner();
