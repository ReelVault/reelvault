import { and, asc, count, countDistinct, eq, gt, inArray, isNotNull, notExists, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { CORE_ARTIFACTS_OWNER } from "@/modules/artifacts/artifacts.constants";
import { MemoryCache } from "@/utils/memory-cache";

interface TrickplayStats {
	total: number;
	withTrickplay: number;
	missingTrickplay: number;
}

/** What a regeneration pass covers: every file, or the files of one library, one title or one season. */
export type TrickplayRegenerationScope = { kind: "all" } | { kind: "library" | "title" | "season"; id: string };

/** One job-count row of a regeneration operation: a status, and the skip reason from its result when there is one. */
export interface RegenerationOutcomeRow {
	status: string;
	skipped: string | null;
	count: number;
}

class TrickplayRepository {
	/** The admin trickplay page polls this whole-catalog aggregate; a short cache
	 * avoids re-running the LEFT JOIN + DISTINCT count on every poll. */
	private readonly statsCache = new MemoryCache<TrickplayStats>({ ttlMs: 5_000, maxSize: 1, name: "trickplay-stats" });

	/** Drops the cached coverage counts, so the admin view reflects previews that were just removed. */
	clearStatsCache(): void {
		this.statsCache.clear();
	}

	/**
	 * Media files with a playable duration that match the scope, in id order. Without `force` the files that
	 * already have core previews are left out, so a pass only fills the gaps.
	 */
	async findMediaFileIdsForRegeneration(scope: TrickplayRegenerationScope, force: boolean, limit: number): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ id: schema.mediaFiles.id })
			.from(schema.mediaFiles)
			.where(this.regenerationFilter(scope, force))
			.orderBy(asc(schema.mediaFiles.id))
			.limit(limit);

		return rows.map((row) => row.id);
	}

	/** How many media files {@link findMediaFileIdsForRegeneration} matches, before its cap. */
	async countForRegeneration(scope: TrickplayRegenerationScope, force: boolean): Promise<number> {
		return await databaseFactory.getClient().$count(schema.mediaFiles, this.regenerationFilter(scope, force));
	}

	/** Media files that have no core-generated trickplay artifacts yet. */
	findMediaFileIdsMissingTrickplay(limit = 2000): Promise<string[]> {
		return this.findMediaFileIdsForRegeneration({ kind: "all" }, false, limit);
	}

	/** Job counts of one operation, grouped by status and by the `skipped` reason in the JSON result. */
	async countRegenerationOutcomes(operationId: string): Promise<RegenerationOutcomeRow[]> {
		const skipped = sql<string | null>`json_extract(${schema.workerJobs.result}, '$.skipped')`;

		return await databaseFactory
			.getClient()
			.select({ status: schema.workerJobs.status, skipped, count: count() })
			.from(schema.workerJobs)
			.where(eq(schema.workerJobs.operationId, operationId))
			.groupBy(schema.workerJobs.status, skipped);
	}

	async stats(): Promise<TrickplayStats> {
		return await this.statsCache.getOrSet("all", async () => {
			const client = databaseFactory.getClient();
			const [row] = await client
				.select({
					// A file can own several trickplay artifacts (multiple versions/resolutions);
					// the LEFT JOIN multiplies rows, so count distinct media files, not join rows.
					total: countDistinct(schema.mediaFiles.id),
					withTrickplay:
						sql<number>`count(DISTINCT CASE WHEN ${schema.mediaArtifacts.id} IS NOT NULL THEN ${schema.mediaFiles.id} END)`.mapWith(Number),
				})
				.from(schema.mediaFiles)
				.leftJoin(
					schema.mediaArtifacts,
					and(
						eq(schema.mediaArtifacts.mediaFileId, schema.mediaFiles.id),
						eq(schema.mediaArtifacts.kind, "trickplay"),
						eq(schema.mediaArtifacts.pluginId, CORE_ARTIFACTS_OWNER),
					),
				)
				.where(and(isNotNull(schema.mediaFiles.duration), gt(schema.mediaFiles.duration, 0)));
			const total = row?.total ?? 0;
			const withTrickplay = row?.withTrickplay ?? 0;

			return { total, withTrickplay, missingTrickplay: total - withTrickplay };
		});
	}

	/** The WHERE clause shared by the scoped list and its count. */
	private regenerationFilter(scope: TrickplayRegenerationScope, force: boolean): SQL | undefined {
		const client = databaseFactory.getClient();
		const conditions: SQL[] = [isNotNull(schema.mediaFiles.duration), gt(schema.mediaFiles.duration, 0)];

		if (!force) {
			conditions.push(
				notExists(
					client
						.select({ one: sql`1` })
						.from(schema.mediaArtifacts)
						.where(
							and(
								eq(schema.mediaArtifacts.mediaFileId, schema.mediaFiles.id),
								eq(schema.mediaArtifacts.kind, "trickplay"),
								eq(schema.mediaArtifacts.pluginId, CORE_ARTIFACTS_OWNER),
							),
						),
				),
			);
		}

		if (scope.kind === "library") {
			conditions.push(eq(schema.mediaFiles.libraryId, scope.id));
		} else if (scope.kind === "title") {
			conditions.push(eq(schema.mediaFiles.metadataId, scope.id));
		} else if (scope.kind === "season") {
			const seasonEpisodes = client.select({ id: schema.episodes.id }).from(schema.episodes).where(eq(schema.episodes.seasonId, scope.id));
			conditions.push(inArray(schema.mediaFiles.episodeId, seasonEpisodes));
		}

		return and(...conditions);
	}
}

export const trickplayRepository = new TrickplayRepository();
