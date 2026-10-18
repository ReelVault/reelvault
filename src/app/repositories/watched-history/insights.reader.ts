import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { systemResourcesService } from "@/config/system-resources.service";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { unique } from "@/utils/array.utils";

/** Local-calendar date key (YYYY-MM-DD) matching SQLite's date(..., 'localtime'). */
function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${date.getFullYear()}-${month}-${day}`;
}

export interface InsightAggregate {
	metadataId: string;
	day: string;
	hour: number;
	dayOfWeek: number;
	month: number;
	durationSum: number;
	durationMax: number;
	fullWatchCount: number;
}

/**
 * Aggregated per (metadata, local day, hour) insight rows instead of raw history rows.
 * Consumers derive totals, heatmaps and per-metadata minutes without loading every play.
 *
 * Grouping happens in memory: the triple-strftime GROUP BY forced a temp B-tree
 * over the whole window (≈125 ms per call on a 100k-row profile history), while
 * the raw fetch rides the (profile_id, watched_at) index and the per-row local
 * date components are computed once in JS.
 */
export async function findInsightAggregates(profileId: string, since?: Date, until?: Date): Promise<InsightAggregate[]> {
	const conditions = [eq(schema.watchedHistory.profileId, profileId)];
	if (since) conditions.push(gte(schema.watchedHistory.watchedAt, since));

	if (until) conditions.push(lt(schema.watchedHistory.watchedAt, until));

	const rows = await databaseFactory
		.getClient()
		.select({
			metadataId: schema.mediaFiles.metadataId,
			watchedAt: schema.watchedHistory.watchedAt,
			durationWatched: schema.watchedHistory.durationWatched,
			isFullWatch: schema.watchedHistory.isFullWatch,
		})
		.from(schema.watchedHistory)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
		.where(and(...conditions));

	const groups = new Map<string, InsightAggregate>();
	for (const row of rows) {
		const date = row.watchedAt;
		const day = localDayKey(date);
		const hour = date.getHours();
		const key = `${row.metadataId}|${day}|${hour}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				metadataId: row.metadataId,
				day,
				hour,
				dayOfWeek: date.getDay(),
				month: date.getMonth() + 1,
				durationSum: 0,
				durationMax: 0,
				fullWatchCount: 0,
			};
			groups.set(key, group);
		}

		const duration = row.durationWatched ?? 0;
		group.durationSum += duration;
		if (duration > group.durationMax) group.durationMax = duration;
		if (row.isFullWatch) group.fullWatchCount += 1;
	}

	return [...groups.values()];
}

/** Genres and cast of the given titles, for the insight page's breakdowns. */
export async function findInsightRelations(metadataIds: string[]) {
	const uniqueMetadataIds = unique(metadataIds);
	if (uniqueMetadataIds.length === 0) return { genres: [], actors: [] };

	const client = databaseFactory.getClient();
	const concurrency = { concurrency: systemResourcesService.getRelationQueryConcurrency() };

	const [genres, actors] = await Promise.all([
		mapChunked(
			uniqueMetadataIds,
			(metadataIdChunk) =>
				client
					.select({ metadataId: schema.metadataGenres.metadataId, name: schema.genres.name })
					.from(schema.metadataGenres)
					.innerJoin(schema.genres, eq(schema.genres.id, schema.metadataGenres.genreId))
					.where(inArray(schema.metadataGenres.metadataId, metadataIdChunk)),
			concurrency,
		),
		mapChunked(
			uniqueMetadataIds,
			(metadataIdChunk) =>
				client
					.select({ metadataId: schema.metadataCast.metadataId, name: schema.people.name })
					.from(schema.metadataCast)
					.innerJoin(schema.people, eq(schema.people.id, schema.metadataCast.personId))
					.where(inArray(schema.metadataCast.metadataId, metadataIdChunk)),
			concurrency,
		),
	]);

	return { genres, actors };
}
