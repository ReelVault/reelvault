import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

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

	async deleteArtifacts(subtitleId: string, subtitle: SubtitleRowReference): Promise<void> {
		const subtitlesPath = this.dependencies.subtitlesPath();
		const deletions: Array<Promise<boolean>> = [this.dependencies.deleteFile(PathUtils.join(subtitlesPath, `${subtitleId}.vtt`))];
		if (subtitle.type === "external" && subtitle.filePath && PathUtils.isSubpath(subtitle.filePath, subtitlesPath)) {
			deletions.push(this.dependencies.deleteFile(subtitle.filePath));
		}

		await Promise.all(deletions);
	}
}

export const subtitleFileCleaner = new SubtitleFileCleaner();
