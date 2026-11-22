import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { DAY } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";

class DiscoverRepository {
	/**
	 * Global trending: metadata items that have been watched most across ALL profiles
	 * in the last `days` days. Used for the trending section (same for every profile).
	 * Returns metadataId + playCount sorted descending.
	 */
	async findRecentlyWatchedByOthers(days = 14, limit = 100) {
		const client = databaseFactory.getClient();
		const since = new Date(Date.now() - days * DAY);

		return await client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				playCount: count(schema.watchedHistory.id),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(and(isNotNull(schema.mediaFiles.metadataId), gte(schema.watchedHistory.watchedAt, since)))
			.groupBy(schema.mediaFiles.metadataId)
			.orderBy(desc(count(schema.watchedHistory.id)))
			.limit(limit);
	}
}

export const discoverRepository = new DiscoverRepository();
