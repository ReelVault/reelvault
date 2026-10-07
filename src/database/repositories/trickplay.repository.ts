import { and, asc, countDistinct, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { MemoryCache } from "@/utils/memory-cache";

const CORE_TRICKPLAY_PLUGIN_ID = "core";

interface TrickplayStats {
	total: number;
	withTrickplay: number;
	missingTrickplay: number;
}

class TrickplayRepository {
	/** The admin trickplay page polls this whole-catalog aggregate; a short cache
	 * avoids re-running the LEFT JOIN + DISTINCT count on every poll. */
	private readonly statsCache = new MemoryCache<TrickplayStats>({ ttlMs: 5_000, maxSize: 1, name: "trickplay-stats" });

	/** Media files that have no core-generated trickplay artifacts yet. */
	async findMediaFileIdsMissingTrickplay(limit = 2000): Promise<string[]> {
		const client = databaseFactory.getClient();
		const rows = await client
			.select({ id: schema.mediaFiles.id })
			.from(schema.mediaFiles)
			.where(
				and(
					isNotNull(schema.mediaFiles.duration),
					gt(schema.mediaFiles.duration, 0),
					notExists(
						client
							.select({ one: sql`1` })
							.from(schema.mediaArtifacts)
							.where(
								and(
									eq(schema.mediaArtifacts.mediaFileId, schema.mediaFiles.id),
									eq(schema.mediaArtifacts.kind, "trickplay"),
									eq(schema.mediaArtifacts.pluginId, CORE_TRICKPLAY_PLUGIN_ID),
								),
							),
					),
				),
			)
			.orderBy(asc(schema.mediaFiles.id))
			.limit(limit);

		return rows.map((row) => row.id);
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
						eq(schema.mediaArtifacts.pluginId, CORE_TRICKPLAY_PLUGIN_ID),
					),
				)
				.where(and(isNotNull(schema.mediaFiles.duration), gt(schema.mediaFiles.duration, 0)));
			const total = row?.total ?? 0;
			const withTrickplay = row?.withTrickplay ?? 0;

			return { total, withTrickplay, missingTrickplay: total - withTrickplay };
		});
	}
}

export const trickplayRepository = new TrickplayRepository();
