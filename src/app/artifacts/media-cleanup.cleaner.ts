import { serverConfig } from "@/config/server/server.config";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { mediaArtifactsService } from "./media-artifacts.service";

interface MediaCleanupPlan {
	artifactStorageKeys: readonly string[];
	subtitleFilePaths: ReadonlyArray<string | null | undefined>;
	subtitleIds?: readonly string[] | undefined;
}

/**
 * Deletes artifact blobs, subtitle files and derived `<id>.vtt` paths after a
 * metadata/media-file/library delete. Subtitle paths outside the managed
 * directory are ignored; I/O fan-out is bounded by the configured budget.
 */
export async function runMediaCleanup(plan: MediaCleanupPlan): Promise<void> {
	const tasks: Array<() => Promise<unknown>> = [
		...plan.artifactStorageKeys.map((storageKey) => async () => FileUtils.delete(PathUtils.join(serverConfig.paths.artifacts, storageKey))),
		...plan.subtitleFilePaths
			.filter((filePath): filePath is string => Boolean(filePath && PathUtils.isSubpath(filePath, serverConfig.paths.subtitles)))
			.map((filePath) => async () => FileUtils.delete(filePath)),
		...(plan.subtitleIds ?? []).map((id) => async () => FileUtils.delete(PathUtils.join(serverConfig.paths.subtitles, `${id}.vtt`))),
	];

	await PromiseUtils.mapConcurrent(tasks, serverConfig.application.cleanupConcurrency, async (task) => task());

	if (plan.artifactStorageKeys.length > 0) {
		// The media-artifacts service caches per-owner byte totals for quota/budget
		// checks; files deleted straight off disk would otherwise keep counting.
		mediaArtifactsService.invalidateByteTotals();
	}
}
