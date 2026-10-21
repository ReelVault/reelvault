import { and, desc, eq, gte, lt, type SQL, type Subquery, sql } from "drizzle-orm";
import { type SQLiteColumn, unionAll } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { metadataImageOn, metadataOn, posterImagesOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import type { TopWatchedRow } from "./top-media.mapper";

/**
 * Plays the admin analytics count: finished titles from watched history plus interrupted sessions that reached the
 * minimum play time. Both arms share one column set; an interrupted session is never a full watch.
 */
function analyticsPlays(since: Date, minInterruptedSeconds: number) {
	const client = databaseFactory.getClient();
	const finished = client
		.select({
			id: schema.watchedHistory.id,
			profileId: schema.watchedHistory.profileId,
			mediaFileId: schema.watchedHistory.mediaFileId,
			durationWatched: schema.watchedHistory.durationWatched,
			isFullWatch: schema.watchedHistory.isFullWatch,
			watchedAt: schema.watchedHistory.watchedAt,
		})
		.from(schema.watchedHistory)
		.where(gte(schema.watchedHistory.watchedAt, since));
	const interrupted = client
		.select({
			id: schema.interruptedPlaybackSessions.id,
			profileId: schema.interruptedPlaybackSessions.profileId,
			mediaFileId: schema.interruptedPlaybackSessions.mediaFileId,
			durationWatched: schema.interruptedPlaybackSessions.playedSeconds,
			isFullWatch: sql<boolean>`0`.as("is_full_watch"),
			watchedAt: schema.interruptedPlaybackSessions.endedAt,
		})
		.from(schema.interruptedPlaybackSessions)
		.where(
			and(
				gte(schema.interruptedPlaybackSessions.endedAt, since),
				gte(schema.interruptedPlaybackSessions.playedSeconds, minInterruptedSeconds),
			),
		);

	return unionAll(finished, interrupted).as("plays");
}

type AnalyticsPlays = ReturnType<typeof analyticsPlays>;

/** Whole minutes played across the given plays, rounded. */
function playedMinutes(plays: AnalyticsPlays): SQL<number> {
	return sql<number>`round(sum(coalesce(${plays.durationWatched}, 0)) / 60.0)`.mapWith(Number);
}

/** The per-title totals a most-watched list ranks, computed by {@link findTopWatchedMedia} or {@link findTopPlayedMedia}. */
type TopTitleTotals = Subquery & {
	metadataId: SQLiteColumn;
	totalDurationWatched: SQL.Aliased<number>;
	watchCount: SQL.Aliased<number>;
	isCompleted: SQL.Aliased<boolean>;
};

/** Joins the poster and metadata onto the top titles, ordered by time played. */
function selectTopMedia<T extends TopTitleTotals>(totals: T) {
	return databaseFactory
		.getClient()
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

export async function findTopWatchedMedia(options: {
	profileId?: string | undefined;
	since?: Date | undefined;
	until?: Date | undefined;
	limit?: number | undefined;
	mediaType?: "movie" | "tv_show" | undefined;
}): Promise<TopWatchedRow[]> {
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

	return await selectTopMedia(totals);
}

/** Most-played titles by time played, over the same plays as {@link findGlobalAnalytics}. */
export async function findTopPlayedMedia({
	since,
	minInterruptedSeconds,
	limit = 10,
}: {
	since: Date;
	minInterruptedSeconds: number;
	limit?: number;
}): Promise<TopWatchedRow[]> {
	const client = databaseFactory.getClient();
	const plays = analyticsPlays(since, minInterruptedSeconds);

	// Aggregate first, join the metadata/poster graphs afterwards (same shape as findTopWatchedMedia).
	const totals = client
		.select({
			metadataId: schema.mediaFiles.metadataId,
			totalDurationWatched: sql<number>`sum(coalesce(${plays.durationWatched}, 0))`.as("total_duration"),
			watchCount: sql<number>`count(${plays.id})`.as("watch_count"),
			isCompleted: sql<boolean>`max(coalesce(${plays.isFullWatch}, 0)) > 0`.as("is_completed"),
		})
		.from(plays)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, plays.mediaFileId))
		.groupBy(schema.mediaFiles.metadataId)
		.orderBy(desc(sql`sum(coalesce(${plays.durationWatched}, 0))`))
		.limit(limit)
		.as("top");

	return await selectTopMedia(totals);
}

/** Admin dashboard figures over finished titles and interrupted sessions since `since`. */
export async function findGlobalAnalytics({ since, minInterruptedSeconds }: { since: Date; minInterruptedSeconds: number }) {
	const plays = analyticsPlays(since, minInterruptedSeconds);

	const [overall, leaderboard, recentPlays, { hourlyRows, dailyRows }] = await Promise.all([
		fetchAnalyticsTotals(plays),
		fetchAnalyticsLeaderboard(plays),
		fetchAnalyticsRecentPlays(plays),
		fetchAnalyticsDistribution(plays),
	]);

	return {
		totalMinutes: overall?.totalMinutes ?? 0,
		totalPlays: overall?.totalPlays ?? 0,
		completedPlays: overall?.completedPlays ?? 0,
		activeUsers: overall?.activeUsers ?? 0,
		leaderboard,
		recentPlays,
		hourlyRows,
		dailyRows,
	};
}

async function fetchAnalyticsTotals(plays: AnalyticsPlays) {
	const [overall] = await databaseFactory
		.getClient()
		.select({
			totalMinutes: playedMinutes(plays),
			totalPlays: sql<number>`count(${plays.id})`.mapWith(Number),
			completedPlays: sql<number>`coalesce(sum(${plays.isFullWatch}), 0)`.mapWith(Number),
			activeUsers: sql<number>`count(distinct ${plays.profileId})`.mapWith(Number),
		})
		.from(plays);

	return overall;
}

async function fetchAnalyticsLeaderboard(plays: AnalyticsPlays) {
	return await databaseFactory
		.getClient()
		.select({
			profileId: schema.profiles.id,
			profileName: schema.profiles.name,
			profileAvatar: schema.profiles.avatarUrl,
			userName: schema.users.name,
			userEmail: schema.users.email,
			totalMinutes: playedMinutes(plays),
			titlesCount: sql<number>`count(distinct ${schema.mediaFiles.metadataId})`.mapWith(Number),
			// max() returns the raw timestamp column: epoch seconds, not a decoded Date.
			lastWatchedAt: sql<number | null>`max(${plays.watchedAt})`.mapWith((seconds) => (seconds ? new Date(seconds * 1000) : null)),
		})
		.from(plays)
		.innerJoin(schema.profiles, eq(schema.profiles.id, plays.profileId))
		.innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, plays.mediaFileId))
		.groupBy(schema.profiles.id)
		.orderBy(desc(sql`sum(coalesce(${plays.durationWatched}, 0))`))
		.limit(10);
}

async function fetchAnalyticsRecentPlays(plays: AnalyticsPlays) {
	return await databaseFactory
		.getClient()
		.select({
			id: plays.id,
			profileName: schema.profiles.name,
			userName: schema.users.name,
			title: schema.metadata.title,
			mediaType: schema.metadata.type,
			posterImageId: schema.metadataImages.imageId,
			durationWatched: plays.durationWatched,
			isFullWatch: plays.isFullWatch,
			watchedAt: plays.watchedAt,
		})
		.from(plays)
		.innerJoin(schema.profiles, eq(schema.profiles.id, plays.profileId))
		.innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, plays.mediaFileId))
		.innerJoin(schema.metadata, metadataOn(schema.mediaFiles.metadataId))
		.leftJoin(schema.metadataImages, posterImagesOn(schema.metadata.id))
		.orderBy(desc(plays.watchedAt))
		.limit(15);
}

/** Minutes and plays grouped by weekday/hour and by local day, merged in memory from one grouped read. */
async function fetchAnalyticsDistribution(plays: AnalyticsPlays) {
	const groupedRows = await databaseFactory
		.getClient()
		.select({
			dayOfWeek: sql<number>`cast(strftime('%w', ${plays.watchedAt}, 'unixepoch', 'localtime') as integer)`.mapWith(Number),
			hour: sql<number>`cast(strftime('%H', ${plays.watchedAt}, 'unixepoch', 'localtime') as integer)`.mapWith(Number),
			day: sql<string>`date(${plays.watchedAt}, 'unixepoch', 'localtime')`,
			minutes: sql<number>`sum(coalesce(${plays.durationWatched}, 0)) / 60.0`.mapWith(Number),
			playCount: sql<number>`count(*)`.mapWith(Number),
		})
		.from(plays)
		.groupBy(
			sql`strftime('%w', ${plays.watchedAt}, 'unixepoch', 'localtime')`,
			sql`strftime('%H', ${plays.watchedAt}, 'unixepoch', 'localtime')`,
			sql`date(${plays.watchedAt}, 'unixepoch', 'localtime')`,
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
