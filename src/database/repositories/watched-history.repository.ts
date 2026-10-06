import type {
	CreateWatchedHistory,
	CursorPaginatedResponse,
	CursorPaginationQuery,
	TopWatchedMedia,
	WatchedHistoryWithRelations,
} from "@reelvault/sdk/common";
import { and, asc, desc, eq, gte, inArray, lt, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { cachedCount, defineTableAccess, filterSignature, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { metadataImageOn, metadataOn, posterImagesOn } from "@/database/utils/join-conditions";
import { type CreatedAtCursor, decodeCursorFor, KeysetCursor, keysetWhere } from "@/database/utils/keyset-cursor";
import { QueryPagination } from "@/database/utils/pagination";
import { QueryUtils } from "@/database/utils/query-parser";
import { daysAgo, serverConstants } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { unique } from "@/utils/array.utils";

const watchedHistory = defineTableAccess("watchedHistory", {
	primaryKeyColumn: "id",
});

interface FindWithMediaOptions {
	limit?: number | undefined;
	offset?: number | undefined;
	sortBy?: "watchedAt" | "createdAt" | undefined;
	sortOrder?: "asc" | "desc" | undefined;
	/** Keyset position — takes precedence over offset and forces watchedAt-desc ordering. */
	cursor?: CreatedAtCursor | undefined;
}

/** Cursor mode orders by the full key (watchedAt, id); the offset path adds the
 * id tiebreaker so pages stay deterministic for equal timestamps. */
function orderByFor(cursor: CreatedAtCursor | undefined, sortColumn: SQLWrapper, sortOrder: "asc" | "desc"): SQL[] {
	if (cursor) return [sql`${desc(schema.watchedHistory.watchedAt)}, ${desc(schema.watchedHistory.id)}`];

	return [sortOrder === "asc" ? asc(sortColumn) : desc(sortColumn), sql`${schema.watchedHistory.id}`];
}

class WatchedHistoryRepository {
	readonly table = schema.watchedHistory;
	readonly primaryKeyColumn = watchedHistory.primaryKeyColumn;
	readonly query = watchedHistory.query;
	readonly selectMany = watchedHistory.selectMany;
	readonly selectFirst = watchedHistory.selectFirst;
	readonly findOrCreate = watchedHistory.findOrCreate;
	readonly insert = watchedHistory.insert;
	readonly update = watchedHistory.update;
	readonly delete = watchedHistory.delete;
	readonly insertReturning = watchedHistory.insertReturning;
	readonly updateReturning = watchedHistory.updateReturning;
	readonly updateAndReturn = watchedHistory.updateAndReturn;
	readonly deleteReturning = watchedHistory.deleteReturning;
	readonly deleteAndReturn = watchedHistory.deleteAndReturn;
	readonly findByIds = watchedHistory.findByIds;
	readonly findByColumnIn = watchedHistory.findByColumnIn;
	readonly count = watchedHistory.count;
	readonly isExists = watchedHistory.isExists;

	async countForProfile(profileId: string): Promise<number> {
		return await this.count({ where: eq(this.table.profileId, profileId) });
	}

	async isWatched(profileId: string, metadataId: string) {
		const client = databaseFactory.getClient();
		const [history] = await client
			.select({ id: schema.watchedHistory.id })
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(and(eq(schema.watchedHistory.profileId, profileId), eq(schema.mediaFiles.metadataId, metadataId)))
			.limit(1);

		return Boolean(history);
	}

	async findWithMedia(profileId: string, options: FindWithMediaOptions) {
		const { limit = 50, offset = 0, sortBy = "watchedAt", sortOrder = "desc", cursor } = options;
		const client = databaseFactory.getClient();
		const sortColumn = sortBy === "createdAt" ? schema.watchedHistory.createdAt : schema.watchedHistory.watchedAt;

		// Cursor mode orders by the full key (watchedAt, id) so pagination stays
		// deterministic even when rows share a timestamp.
		const where = cursor
			? and(eq(schema.watchedHistory.profileId, profileId), keysetWhere(schema.watchedHistory.watchedAt, schema.watchedHistory.id, cursor))
			: eq(schema.watchedHistory.profileId, profileId);

		const rows = await client
			.select({
				history: schema.watchedHistory,
				metadata: schema.metadata,
				episode: schema.episodes,
				season: schema.seasons,
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.innerJoin(schema.metadata, metadataOn(schema.mediaFiles.metadataId))
			.leftJoin(schema.episodes, eq(schema.episodes.id, schema.mediaFiles.episodeId))
			.leftJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
			.where(where)
			// Honor the route's declared sortBy/sortOrder contract (audit 2026-09-15).
			// The id tiebreaker keeps offset pages deterministic for equal timestamps.
			.orderBy(...orderByFor(cursor, sortColumn, sortOrder))
			.limit(limit)
			.offset(cursor ? 0 : offset);

		// Backdrops batched for the page instead of one correlated subquery per row.
		const metadataIds = unique(rows, (row) => row.metadata.id);
		const backdropByMetadataId = new Map<string, typeof schema.images.$inferSelect | undefined>();
		if (metadataIds.length > 0) {
			const backdrops = await client
				.select({ metadataId: schema.metadataImages.metadataId, image: schema.images })
				.from(schema.metadataImages)
				.innerJoin(schema.images, metadataImageOn)
				.where(and(inArray(schema.metadataImages.metadataId, metadataIds), eq(schema.metadataImages.imageType, "backdrop")));
			for (const backdrop of backdrops) {
				if (!backdropByMetadataId.has(backdrop.metadataId)) backdropByMetadataId.set(backdrop.metadataId, backdrop.image);
			}
		}

		return rows.map((row) => ({ ...row, backdrop: backdropByMetadataId.get(row.metadata.id) ?? null }));
	}

	async findPage(
		profileId: string,
		query: CursorPaginationQuery & { sortBy?: "watchedAt" | "createdAt"; sortOrder?: "asc" | "desc" },
	): Promise<CursorPaginatedResponse<WatchedHistoryWithRelations>> {
		const { pagination } = QueryUtils.parseStandard(query);
		const sortBy = query.sortBy ?? "watchedAt";
		const sortOrder = query.sortOrder ?? "desc";
		// Keyset pagination on the default listing (watchedAt desc) — offset pages
		// scan past all preceding joined rows, a cursor seeks straight to the key.
		const cursorMode = sortBy === "watchedAt" && sortOrder === "desc";
		const cursor = decodeCursorFor(query.cursor, cursorMode, "Pagination cursor requires descending watchedAt sorting");

		// The per-profile total only changes on history writes; caching it keeps the
		// COUNT scan out of every page request (the write paths clear this cache's
		// 10 s TTL via clearEtagBodyCache-driven invalidation of the HTTP body cache,
		// which the pagination total shares its staleness contract with).
		const countFilters = { profileId };
		const [total, rows] = await Promise.all([
			cachedCount("watchedHistory", filterSignature(countFilters, countFilters), () => this.countForProfile(profileId)),
			this.findWithMedia(profileId, { limit: pagination.limit, offset: pagination.offset, sortBy, sortOrder, cursor }),
		]);

		const response = QueryPagination.createResponse({
			total,
			pagination: cursor ? { ...pagination, page: 1, offset: 0 } : pagination,
			data: rows.map(({ history, metadata, episode, season, backdrop }) => ({ ...history, metadata, episode, season, backdrop })),
		});

		// The default listing is cursor mode, so the FIRST page must already carry
		// nextCursor — gating on the incoming cursor would starve it forever.
		if (!cursorMode || rows.length < pagination.limit) return response;

		const last = rows.at(-1);
		if (!last) return response;

		return { ...response, nextCursor: KeysetCursor.encode({ createdAt: last.history.watchedAt.getTime(), id: last.history.id }) };
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
	async findInsightAggregates(profileId: string, since?: Date, until?: Date) {
		const client = databaseFactory.getClient();
		const conditions = [eq(this.table.profileId, profileId)];
		if (since) conditions.push(gte(this.table.watchedAt, since));

		if (until) conditions.push(lt(this.table.watchedAt, until));

		const rows = await client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				watchedAt: schema.watchedHistory.watchedAt,
				durationWatched: schema.watchedHistory.durationWatched,
				isFullWatch: schema.watchedHistory.isFullWatch,
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(and(...conditions));

		const groups = new Map<
			string,
			{
				metadataId: string;
				day: string;
				hour: number;
				dayOfWeek: number;
				month: number;
				durationSum: number;
				durationMax: number;
				fullWatchCount: number;
			}
		>();
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

	async findTopWatchedMedia(options: {
		profileId?: string | undefined;
		since?: Date | undefined;
		until?: Date | undefined;
		limit?: number | undefined;
		mediaType?: "movie" | "tv_show" | undefined;
	}) {
		const client = databaseFactory.getClient();
		const conditions: SQL[] = [];
		if (options.profileId) {
			conditions.push(eq(schema.watchedHistory.profileId, options.profileId));
		}

		if (options.since) {
			conditions.push(gte(schema.watchedHistory.watchedAt, options.since));
		}

		if (options.until) {
			conditions.push(lt(schema.watchedHistory.watchedAt, options.until));
		}

		if (options.mediaType) {
			conditions.push(eq(schema.metadata.type, options.mediaType));
		}

		const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

		// Aggregate first, join the metadata/poster graphs afterwards: grouping the
		// five-way joined rows re-read metadata and poster rows once per play
		// (≈226 ms per call on a 100k-row history), while the CTE touches only
		// watched_history + media_files and the joins apply to the top rows alone.
		let totalsQuery = client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				totalDurationWatched: sql<number>`sum(coalesce(${schema.watchedHistory.durationWatched}, 0))`.as("total_duration"),
				watchCount: sql<number>`count(${schema.watchedHistory.id})`.as("watch_count"),
				isCompleted: sql<boolean>`max(coalesce(${schema.watchedHistory.isFullWatch}, 0)) > 0`.as("is_completed"),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.$dynamic();
		// The type filter must shrink the grouped set before the limit, so the
		// metadata join is pulled inside only when a mediaType is requested.
		if (options.mediaType) {
			totalsQuery = totalsQuery.innerJoin(schema.metadata, metadataOn(schema.mediaFiles.metadataId));
		}

		const totals = totalsQuery
			.where(whereClause)
			.groupBy(schema.mediaFiles.metadataId)
			.orderBy(desc(sql`sum(coalesce(${schema.watchedHistory.durationWatched}, 0))`))
			.limit(options.limit ?? 10)
			.as("top");

		return await client
			.select({
				id: schema.metadata.id,
				title: schema.metadata.title,
				type: schema.metadata.type,
				releaseDate: schema.metadata.releaseDate,
				posterImageId: schema.metadataImages.imageId,
				posterImageUpdatedAt: schema.images.updatedAt,
				totalDurationWatched: sql<number>`${totals.totalDurationWatched}`.mapWith(Number),
				watchCount: sql<number>`${totals.watchCount}`.mapWith(Number),
				isCompleted: sql<boolean>`${totals.isCompleted}`.mapWith(Boolean),
			})
			.from(totals)
			.innerJoin(schema.metadata, metadataOn(totals.metadataId))
			.leftJoin(schema.metadataImages, posterImagesOn(schema.metadata.id))
			.leftJoin(schema.images, metadataImageOn)
			.orderBy(desc(totals.totalDurationWatched));
	}

	async findGlobalAnalytics(since?: Date, until?: Date) {
		const whereClause = this.buildAnalyticsWhereClause(since, until);

		const [overall, leaderboard, recentPlays, { hourlyRows, dailyRows }] = await Promise.all([
			this.fetchAnalyticsTotals(whereClause),
			this.fetchAnalyticsLeaderboard(whereClause),
			this.fetchAnalyticsRecentPlays(whereClause),
			this.fetchAnalyticsDistribution(whereClause),
		]);

		return {
			totalMinutes: overall?.totalMinutes ?? 0,
			totalPlays: overall?.totalPlays ?? 0,
			activeUsers: overall?.activeUsers ?? 0,
			leaderboard,
			recentPlays,
			hourlyRows,
			dailyRows,
		};
	}

	private buildAnalyticsWhereClause(since?: Date, until?: Date): SQL | undefined {
		const conditions: SQL[] = [];
		if (since) conditions.push(gte(schema.watchedHistory.watchedAt, since));
		else conditions.push(gte(schema.watchedHistory.watchedAt, daysAgo(90)));

		if (until) conditions.push(lt(schema.watchedHistory.watchedAt, until));

		return conditions.length > 0 ? and(...conditions) : undefined;
	}

	private async fetchAnalyticsTotals(whereClause: SQL | undefined) {
		const client = databaseFactory.getClient();
		const [overall] = await client
			.select({
				totalMinutes: sql<number>`round(sum(coalesce(${schema.watchedHistory.durationWatched}, 0)) / 60.0)`.mapWith(Number),
				totalPlays: sql<number>`count(${schema.watchedHistory.id})`.mapWith(Number),
				activeUsers: sql<number>`count(distinct ${schema.watchedHistory.profileId})`.mapWith(Number),
			})
			.from(schema.watchedHistory)
			.where(whereClause);

		return overall;
	}

	private async fetchAnalyticsLeaderboard(whereClause: SQL | undefined) {
		const client = databaseFactory.getClient();

		return await client
			.select({
				profileId: schema.profiles.id,
				profileName: schema.profiles.name,
				profileAvatar: schema.profiles.avatarUrl,
				userName: schema.users.name,
				userEmail: schema.users.email,
				totalMinutes: sql<number>`round(sum(coalesce(${schema.watchedHistory.durationWatched}, 0)) / 60.0)`.mapWith(Number),
				titlesCount: sql<number>`count(distinct ${schema.mediaFiles.metadataId})`.mapWith(Number),
				lastWatchedAt: sql<Date | null>`max(${schema.watchedHistory.watchedAt})`.mapWith((v: Date | null) => (v ? new Date(v) : null)),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.profiles, eq(schema.profiles.id, schema.watchedHistory.profileId))
			.innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(whereClause)
			.groupBy(schema.profiles.id)
			.orderBy(desc(sql`sum(coalesce(${schema.watchedHistory.durationWatched}, 0))`))
			.limit(10);
	}

	private async fetchAnalyticsRecentPlays(whereClause: SQL | undefined) {
		const client = databaseFactory.getClient();

		return await client
			.select({
				id: schema.watchedHistory.id,
				profileName: schema.profiles.name,
				userName: schema.users.name,
				title: schema.metadata.title,
				mediaType: schema.metadata.type,
				posterImageId: schema.metadataImages.imageId,
				durationWatched: schema.watchedHistory.durationWatched,
				isFullWatch: schema.watchedHistory.isFullWatch,
				watchedAt: schema.watchedHistory.watchedAt,
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.profiles, eq(schema.profiles.id, schema.watchedHistory.profileId))
			.innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.innerJoin(schema.metadata, metadataOn(schema.mediaFiles.metadataId))
			.leftJoin(schema.metadataImages, posterImagesOn(schema.metadata.id))
			.where(whereClause)
			.orderBy(desc(schema.watchedHistory.watchedAt))
			.limit(15);
	}

	private async fetchAnalyticsDistribution(whereClause: SQL | undefined) {
		const client = databaseFactory.getClient();
		const groupedRows = await client
			.select({
				dayOfWeek: sql<number>`cast(strftime('%w', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime') as integer)`.mapWith(
					Number,
				),
				hour: sql<number>`cast(strftime('%H', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime') as integer)`.mapWith(Number),
				day: sql<string>`date(${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime')`,
				minutes: sql<number>`sum(coalesce(${schema.watchedHistory.durationWatched}, 0)) / 60.0`.mapWith(Number),
				playCount: sql<number>`count(*)`.mapWith(Number),
			})
			.from(schema.watchedHistory)
			.where(whereClause)
			.groupBy(
				sql`strftime('%w', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime')`,
				sql`strftime('%H', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime')`,
				sql`date(${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime')`,
			);

		const hourlyBySlot = new Map<string, { dayOfWeek: number; hour: number; minutes: number }>();
		const dailyByDay = new Map<string, { day: string; minutes: number; playCount: number }>();
		for (const row of groupedRows) {
			const slotKey = `${row.dayOfWeek}:${row.hour}`;
			const slot = hourlyBySlot.get(slotKey);
			if (slot) slot.minutes += row.minutes;
			else hourlyBySlot.set(slotKey, { dayOfWeek: row.dayOfWeek, hour: row.hour, minutes: row.minutes });

			const dayRow = dailyByDay.get(row.day);
			if (dayRow) {
				dayRow.minutes += row.minutes;
				dayRow.playCount += row.playCount;
			} else {
				dailyByDay.set(row.day, { day: row.day, minutes: row.minutes, playCount: row.playCount });
			}
		}

		const hourlyRows = [...hourlyBySlot.values()].map((slot) => ({ ...slot, minutes: Math.round(slot.minutes) }));
		const dailyRows = [...dailyByDay.values()]
			.map((row) => ({ ...row, minutes: Math.round(row.minutes) }))
			.toSorted((left, right) => left.day.localeCompare(right.day));

		return { hourlyRows, dailyRows };
	}

	async findInsightRelations(metadataIds: string[]) {
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

	async sync(
		{ profileId, mediaFileId, durationWatched, isFullWatch }: CreateWatchedHistory & { profileId: string },
		tx?: DatabaseTransaction,
	) {
		await this.insert({
			values: {
				profileId,
				mediaFileId,
				durationWatched,
				isFullWatch,
				watchedAt: new Date(),
			},
			tx,
		});
	}

	async clearForProfile(profileId: string, tx?: DatabaseTransaction) {
		await this.delete({ where: eq(this.table.profileId, profileId), tx });
	}

	async pruneOlderThan(cutoff: Date): Promise<number> {
		const result = await databaseFactory.getClient().delete(schema.watchedHistory).where(lt(schema.watchedHistory.watchedAt, cutoff));

		return result.changes;
	}
}

/** Local-calendar date key (YYYY-MM-DD) matching SQLite's date(..., 'localtime'). */
function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${date.getFullYear()}-${month}-${day}`;
}

export interface TopWatchedRow {
	id: string;
	title: string;
	type: "movie" | "tv_show";
	releaseDate: string | null;
	posterImageId: string | null;
	posterImageUpdatedAt: Date | null;
	totalDurationWatched: number;
	watchCount: number;
	isCompleted: boolean;
}

export function toTopWatchedMedia(row: TopWatchedRow): TopWatchedMedia {
	return {
		id: row.id,
		title: row.title,
		type: row.type,
		posterUrl: row.posterImageId ? `${serverConstants.security.imageRoutePrefix}${row.posterImageId}` : null,
		posterUpdatedAt: row.posterImageUpdatedAt ?? null,
		backdropUrl: null,
		releaseYear: row.releaseDate ? new Date(row.releaseDate).getFullYear() : null,
		minutes: Math.round(row.totalDurationWatched / 60),
		watchCount: row.watchCount,
		completed: row.isCompleted,
	};
}

export const watchedHistoryRepository = new WatchedHistoryRepository();
