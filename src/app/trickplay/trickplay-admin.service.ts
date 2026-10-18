import type { TrickplayRegenerationReport, TrickplayStats } from "@reelvault/sdk/common";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { type TrickplayRegenerationScope, trickplayRepository } from "@/app/repositories/trickplay.repository";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { resolveCoreArtifactsBudgetBytes } from "@/modules/artifacts/artifacts-budget.utils";
import { summarizeRegenerationOutcomes } from "@/modules/trickplay/trickplay-regeneration.report";

/** Admin view of trickplay coverage, regeneration scopes and stored previews. Reads and removes through the application's stores. */
class TrickplayAdminService {
	/** Media files that have no core-generated trickplay artifacts yet. */
	findMediaFileIdsMissingTrickplay(limit = 2000): Promise<string[]> {
		return trickplayRepository.findMediaFileIdsMissingTrickplay(limit);
	}

	/** Media files of a regeneration scope, capped at `limit`; the caller reports how many matched beyond the cap. */
	findMediaFileIdsForRegeneration(scope: TrickplayRegenerationScope, force: boolean, limit: number): Promise<string[]> {
		return trickplayRepository.findMediaFileIdsForRegeneration(scope, force, limit);
	}

	countForRegeneration(scope: TrickplayRegenerationScope, force: boolean): Promise<number> {
		return trickplayRepository.countForRegeneration(scope, force);
	}

	/** Media files of several scopes, in scope order and capped at `limit` in total. */
	async findMediaFileIdsForRegenerations(scopes: readonly TrickplayRegenerationScope[], force: boolean, limit: number): Promise<string[]> {
		const ids: string[] = [];
		for (const scope of scopes) {
			if (ids.length >= limit) break;

			ids.push(...(await trickplayRepository.findMediaFileIdsForRegeneration(scope, force, limit - ids.length)));
		}

		return ids;
	}

	/** How many media files the scopes match in total, before the cap. */
	async countForRegenerations(scopes: readonly TrickplayRegenerationScope[], force: boolean): Promise<number> {
		const counts = await Promise.all(scopes.map((scope) => trickplayRepository.countForRegeneration(scope, force)));

		return counts.reduce((sum, count) => sum + count, 0);
	}

	/** Outcome counts of one regeneration operation, with the jobs the storage budget skipped on their own line. */
	async regenerationReport(operationId: string): Promise<TrickplayRegenerationReport> {
		return summarizeRegenerationOutcomes(operationId, await trickplayRepository.countRegenerationOutcomes(operationId));
	}

	/**
	 * Removes the core trickplay previews of each media file. A file without previews, or an unknown id,
	 * counts as nothing removed rather than an error, so a bulk request can name files it did not check.
	 */
	async deletePreviews(
		mediaFileIds: readonly string[],
		options: { dryRun?: boolean | undefined } = {},
	): Promise<{ mediaFiles: number; artifacts: number }> {
		let mediaFiles = 0;
		let artifacts = 0;
		for (const mediaFileId of new Set(mediaFileIds)) {
			const deleted = options.dryRun
				? await mediaArtifactsService.countByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER)
				: await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER);
			if (deleted > 0) {
				mediaFiles++;
				artifacts += deleted;
			}
		}

		if (!options.dryRun) trickplayRepository.clearStatsCache();

		return { mediaFiles, artifacts };
	}

	/** Coverage counts plus the core artifact storage usage/budget for the admin page. */
	async stats(): Promise<TrickplayStats> {
		const [counts, storageBytes, storageBudgetBytes] = await Promise.all([
			trickplayRepository.stats(),
			mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER),
			resolveCoreArtifactsBudgetBytes(),
		]);

		return { ...counts, storageBytes, storageBudgetBytes };
	}
}

export const trickplayAdminService = new TrickplayAdminService();
