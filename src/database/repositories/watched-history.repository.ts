import type {
	CreateWatchedHistory,
	PaginatedResponse,
	PaginationQuery,
	TopWatchedMedia,
	WatchedHistoryWithRelations,
} from "@reelvault/sdk/common";
import { and, asc, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { cachedCount, defineTableAccess, filterSignature, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryPagination } from "@/database/utils/pagination";
import { QueryUtils } from "@/database/utils/query-parser";
import { serverConfig } from "@/server.config";
import { daysAgo } from "@/server.constants";
import { unique } from "@/utils/array.utils";

const watchedHistory = defineTableAccess("watchedHistory", {
	primaryKeyColumn: "id",
});

class WatchedHistoryRepository {
	readonly table = schema.watchedHistory;
	readonly primaryKeyColumn = watchedHistory.primaryKeyColumn;
	readonly query = watchedHistory.query;
	readonly selectMany = watchedHistory.selectMany;
	readonly selectFirst = watchedHistory.selectFirst;
	readonly findMany = watchedHistory.findMany;
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

	async findWithMedia(
		profileId: string,
		limit: number,
		offset: number,
		sortBy: "watchedAt" | "createdAt" = "watchedAt",
		sortOrder: "asc" | "desc" = "desc",
	) {
		const client = databaseFactory.getClient();
		const rows = await client
			.select({
				history: schema.watchedHistory,
				metadata: schema.metadata,
				episode: schema.episodes,
				season: schema.seasons,
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.innerJoin(schema.metadata, eq(schema.metadata.id, schema.mediaFiles.metadataId))
			.leftJoin(schema.episodes, eq(schema.episodes.id, schema.mediaFiles.episodeId))
			.leftJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
			.where(eq(schema.watchedHistory.profileId, profileId))
			// Honor the route's declared sortBy/sortOrder contract (audit 2026-09-15).
			.orderBy(
				sortOrder === "asc"
					? asc(sortBy === "createdAt" ? schema.watchedHistory.createdAt : schema.watchedHistory.watchedAt)
					: desc(sortBy === "createdAt" ? schema.watchedHistory.createdAt : schema.watchedHistory.watchedAt),
			)
			.limit(limit)
			.offset(offset);

		// Backdrops batched for the page instead of one correlated subquery per row.
		const metadataIds = unique(rows, (row) => row.metadata.id);
		const backdropByMetadataId = new Map<string, typeof schema.images.$inferSelect | undefined>();
		if (metadataIds.length > 0) {
			const backdrops = await client
				.select({ metadataId: schema.metadataImages.metadataId, image: schema.images })
				.from(schema.metadataImages)
				.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
				.where(and(inArray(schema.metadataImages.metadataId, metadataIds), eq(schema.metadataImages.imageType, "backdrop")));
			for (const backdrop of backdrops) {
				if (!backdropByMetadataId.has(backdrop.metadataId)) backdropByMetadataId.set(backdrop.metadataId, backdrop.image);
			}
		}

		return rows.map((row) => ({ ...row, backdrop: backdropByMetadataId.get(row.metadata.id) ?? null }));
	}

	async findPage(
		profileId: string,
		query: PaginationQuery & { sortBy?: "watchedAt" | "createdAt"; sortOrder?: "asc" | "desc" },
	): Promise<PaginatedResponse<WatchedHistoryWithRelations>> {
		const { pagination } = QueryUtils.parseStandard(query);
		const sortBy = query.sortBy ?? "watchedAt";
		const sortOrder = query.sortOrder ?? "desc";
		// The per-profile total only changes on history writes; caching it keeps the
		// COUNT scan out of every page request (the write paths clear this cache's
		// 10 s TTL via clearEtagBodyCache-driven invalidation of the HTTP body cache,
		// which the pagination total shares its staleness contract with).
		const countFilters = { profileId };
		const [total, rows] = await Promise.all([
			cachedCount("watchedHistory", filterSignature(countFilters, countFilters), () => this.countForProfile(profileId)),
			this.findWithMedia(profileId, pagination.limit, pagination.offset, sortBy, sortOrder),
		]);

		return QueryPagination.createResponse({
			total,
			pagination,
			data: rows.map(({ history, metadata, episode, season, backdrop }) => ({ ...history, metadata, episode, season, backdrop })),
		});
	}

	/**
	 * Aggregated per (metadata, local day, hour) insight rows instead of raw history rows.
	 * Consumers derive totals, heatmaps and per-metadata minutes without loading every play.
	 */
	async findInsightAggregates(profileId: string, since?: Date, until?: Date) {
		const client = databaseFactory.getClient();
		const conditions = [eq(this.table.profileId, profileId)];
		if (since) conditions.push(gte(this.table.watchedAt, since));

		if (until) conditions.push(lt(this.table.watchedAt, until));

		const localDay = sql<string | null>`date(${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime')`;
		const localHour = sql<number>`cast(strftime('%H', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime') as integer)`;
		const localDow = sql<number>`cast(strftime('%w', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime') as integer)`;
		const localMonth = sql<number>`cast(strftime('%m', ${schema.watchedHistory.watchedAt}, 'unixepoch', 'localtime') as integer)`;

		return await client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				day: localDay,
				hour: localHour.mapWith(Number),
				dayOfWeek: localDow.mapWith(Number),
				month: localMonth.mapWith(Number),
				durationSum: sql<number>`coalesce(sum(${schema.watchedHistory.durationWatched}), 0)`.mapWith(Number),
				durationMax: sql<number>`coalesce(max(${schema.watchedHistory.durationWatched}), 0)`.mapWith(Number),
				fullWatchCount: sql<number>`coalesce(sum(case when ${schema.watchedHistory.isFullWatch} then 1 else 0 end), 0)`.mapWith(Number),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(and(...conditions))
			.groupBy(schema.mediaFiles.metadataId, localDay, localHour);
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

		return await client
			.select({
				id: schema.metadata.id,
				title: schema.metadata.title,
				type: schema.metadata.type,
				releaseDate: schema.metadata.releaseDate,
				posterImageId: schema.metadataImages.imageId,
				posterImageUpdatedAt: schema.images.updatedAt,
				totalDurationWatched: sql<number>`sum(coalesce(${schema.watchedHistory.durationWatched}, 0))`.mapWith(Number),
				watchCount: sql<number>`count(${schema.watchedHistory.id})`.mapWith(Number),
				isCompleted: sql<boolean>`max(coalesce(${schema.watchedHistory.isFullWatch}, 0)) > 0`.mapWith(Boolean),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.innerJoin(schema.metadata, eq(schema.metadata.id, schema.mediaFiles.metadataId))
			.leftJoin(
				schema.metadataImages,
				and(eq(schema.metadataImages.metadataId, schema.metadata.id), eq(schema.metadataImages.imageType, "poster")),
			)
			.leftJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
			.where(whereClause)
			.groupBy(schema.metadata.id)
			.orderBy(desc(sql`sum(coalesce(${schema.watchedHistory.durationWatched}, 0))`))
			.limit(options.limit ?? 10);
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
			.innerJoin(schema.metadata, eq(schema.metadata.id, schema.mediaFiles.metadataId))
			.leftJoin(
				schema.metadataImages,
				and(eq(schema.metadataImages.metadataId, schema.metadata.id), eq(schema.metadataImages.imageType, "poster")),
			)
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
		const concurrency = { concurrency: serverConfig.database.relationQueryConcurrency };

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

	async syncInTransaction(input: CreateWatchedHistory & { profileId: string }): Promise<void> {
		await this.sync(input);
	}

	async clearForProfile(profileId: string, tx?: DatabaseTransaction) {
		await this.delete({ where: eq(this.table.profileId, profileId), tx });
	}
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
		posterUrl: row.posterImageId ? `${serverConfig.security.imageRoutePrefix}${row.posterImageId}` : null,
		posterUpdatedAt: row.posterImageUpdatedAt ?? null,
		backdropUrl: null,
		releaseYear: row.releaseDate ? new Date(row.releaseDate).getFullYear() : null,
		minutes: Math.round(row.totalDurationWatched / 60),
		watchCount: row.watchCount,
		completed: row.isCompleted,
	};
}

export const watchedHistoryRepository = new WatchedHistoryRepository();
