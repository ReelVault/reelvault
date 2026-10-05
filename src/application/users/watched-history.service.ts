import type {
	CreateWatchedHistory,
	GenreDistribution,
	InsightsRange,
	PaginatedResponse,
	PaginationQuery,
	ProfileInsights,
	TopWatchedMedia,
	WatchedHistoryWithRelations,
	WrappedInsights,
} from "@reelvault/sdk/common";
import { buildHourlyHeatmap, recentDayKeys } from "@/application/analytics.utils";
import { toTopWatchedMedia, watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { DAY } from "@/server.constants";
import { maxBy } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { clearProfileInsights, invalidateProfileCaches, profileInsightsCache, wrappedInsightsCache } from "./cache-invalidation";

const RANGE_DAYS: Record<InsightsRange, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: 365 };

class WatchedHistoryService extends BaseService {
	constructor() {
		super("WatchedHistoryService");
	}

	clearCache(profileId?: string): void {
		if (profileId) {
			clearProfileInsights(profileId);
		} else {
			profileInsightsCache.clear();
			wrappedInsightsCache.clear();
		}
	}

	async getAll(
		query: PaginationQuery & { sortBy?: "watchedAt" | "createdAt"; sortOrder?: "asc" | "desc" },
		profileId?: string,
	): Promise<PaginatedResponse<WatchedHistoryWithRelations>> {
		return await this.safeExecute("getAll", async () => {
			this.assertProfileId(profileId);

			return await watchedHistoryRepository.findPage(profileId, query);
		});
	}

	async sync(body: CreateWatchedHistory, profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("sync", async () => {
			this.assertProfileId(profileId);
			await watchedHistoryRepository.sync({ ...body, profileId });
			invalidateProfileCaches(profileId);

			return { success: true };
		});
	}

	async getInsights(range: InsightsRange, profileId?: string): Promise<ProfileInsights> {
		this.assertProfileId(profileId);
		const cacheKey = `${profileId}:insights:${range}`;

		return await profileInsightsCache.getOrSet(cacheKey, async () => {
			const now = new Date();
			const days = RANGE_DAYS[range];
			const since = new Date(now.getTime() - days * DAY);
			const previousSince = new Date(since.getTime() - days * DAY);

			const [currentRows, previousRows, topMoviesRaw, topShowsRaw] = await Promise.all([
				watchedHistoryRepository.findInsightAggregates(profileId, since, now),
				watchedHistoryRepository.findInsightAggregates(profileId, previousSince, since),
				watchedHistoryRepository.findTopWatchedMedia({ profileId, since, limit: 10, mediaType: "movie" }),
				watchedHistoryRepository.findTopWatchedMedia({ profileId, since, limit: 10, mediaType: "tv_show" }),
			]);

			const totalMinutes = sumMinutes(currentRows);
			const previousPeriodMinutes = sumMinutes(previousRows);

			// Calculate metadata minutes
			let longestSessionSeconds = 0;
			let completedCount = 0;

			for (const row of currentRows) {
				if (row.durationMax > longestSessionSeconds) longestSessionSeconds = row.durationMax;

				completedCount += row.fullWatchCount;
			}

			const metadataMinutes = accumulateMinutes(currentRows);

			const relations = await watchedHistoryRepository.findInsightRelations([...metadataMinutes.keys()]);
			const genreAggregated = aggregateMinutesByName(relations.genres, metadataMinutes);
			const genresDistribution = computeGenresDistributionFromAggregated(genreAggregated, totalMinutes);

			const topMovies: TopWatchedMedia[] = topMoviesRaw.map((m) => toTopWatchedMedia(m));

			const topShows: TopWatchedMedia[] = topShowsRaw.map((s) => toTopWatchedMedia(s));

			return {
				range,
				totalMinutes,
				previousPeriodMinutes,
				dailyAverageMinutes: Math.round(totalMinutes / Math.max(1, days)),
				titlesWatched: metadataMinutes.size,
				completedTitlesCount: completedCount,
				longestSessionMinutes: Math.round(longestSessionSeconds / 60),
				topGenre: topFromAggregated(genreAggregated),
				topActor: topRelation(relations.actors, metadataMinutes),
				topMovies,
				topShows,
				genresDistribution,
				hourlyHeatmap: buildHourlyHeatmap(
					currentRows.map((row) => ({ dayOfWeek: row.dayOfWeek, hour: row.hour, minutes: Math.round(row.durationSum / 60) })),
				),
				dailyActivity: activityByDay(currentRows, days, now),
			};
		});
	}

	async getWrapped(year: number, profileId?: string): Promise<WrappedInsights> {
		this.assertProfileId(profileId);
		const cacheKey = `${profileId}:wrapped:${year}`;

		return await wrappedInsightsCache.getOrSet(cacheKey, async () => {
			const since = new Date(year, 0, 1, 0, 0, 0);
			const until = new Date(year + 1, 0, 1, 0, 0, 0);

			const [rows, topMoviesRaw, topShowsRaw] = await Promise.all([
				watchedHistoryRepository.findInsightAggregates(profileId, since, until),
				watchedHistoryRepository.findTopWatchedMedia({ profileId, since, until, limit: 5, mediaType: "movie" }),
				watchedHistoryRepository.findTopWatchedMedia({ profileId, since, until, limit: 5, mediaType: "tv_show" }),
			]);

			const totalMinutes = sumMinutes(rows);
			const totalDays = Number((totalMinutes / 1440).toFixed(1));

			const metadataMinutes = accumulateMinutes(rows);
			const monthTotals = new Map<number, number>();
			const weekdayTotals = new Map<number, number>();
			const dayTotals = new Map<string, number>();

			let moviesCount = 0;
			let episodesCount = 0;

			for (const row of rows) {
				const durationMinutes = Math.round(row.durationSum / 60);

				const m = row.month - 1;
				const prevMonth = monthTotals.get(m) ?? 0;
				monthTotals.set(m, prevMonth + durationMinutes);

				const d = row.dayOfWeek;
				const prevWeekday = weekdayTotals.get(d) ?? 0;
				weekdayTotals.set(d, prevWeekday + durationMinutes);

				if (row.day) {
					const prevDay = dayTotals.get(row.day) ?? 0;
					dayTotals.set(row.day, prevDay + durationMinutes);
				}
			}

			const relations = await watchedHistoryRepository.findInsightRelations([...metadataMinutes.keys()]);
			const topGenres = computeGenresDistributionFromAggregated(aggregateMinutesByName(relations.genres, metadataMinutes), totalMinutes);
			const topActors = computeRankedActors(relations.actors, metadataMinutes);

			// Peak month calculation (0-based month index — the frontend formats it).
			const peakMonthEntry = maxBy([...monthTotals.entries()], ([, minutes]) => minutes);
			const peakMonth = peakMonthEntry && peakMonthEntry[1] > 0 ? { month: peakMonthEntry[0], minutes: peakMonthEntry[1] } : null;

			// Peak weekday calculation (0 = Sunday — the frontend formats it).
			const peakWeekdayEntry = maxBy([...weekdayTotals.entries()], ([, minutes]) => minutes);
			const peakDayOfWeek =
				peakWeekdayEntry && peakWeekdayEntry[1] > 0 ? { dayOfWeek: peakWeekdayEntry[0], minutes: peakWeekdayEntry[1] } : null;

			// Longest marathon day
			const longestMarathonMinutes = maxBy([...dayTotals.values()], (minutes) => minutes) ?? 0;

			const topMovies: TopWatchedMedia[] = topMoviesRaw.map((m) => {
				moviesCount += m.watchCount;

				return toTopWatchedMedia(m);
			});

			const topShows: TopWatchedMedia[] = topShowsRaw.map((s) => {
				episodesCount += s.watchCount;

				return toTopWatchedMedia(s);
			});

			const personality = getViewerPersonality(topGenres, totalMinutes, longestMarathonMinutes);

			return {
				year,
				totalMinutes,
				totalDays,
				titlesWatched: metadataMinutes.size,
				moviesWatchedCount: moviesCount,
				episodesWatchedCount: episodesCount,
				topMovie: topMovies[0] ?? null,
				topShow: topShows[0] ?? null,
				topMovies,
				topShows,
				topGenres,
				topActors,
				peakMonth,
				peakDayOfWeek,
				longestMarathonMinutes,
				viewerPersonality: personality,
			};
		});
	}

	async isWatched(metadataId: string, profileId?: string): Promise<{ watched: boolean }> {
		return await this.safeExecute("isWatched", async () => {
			this.assertProfileId(profileId);
			const watched = await watchedHistoryRepository.isWatched(profileId, metadataId);

			return { watched };
		});
	}

	async clear(profileId?: string): Promise<{ success: true }> {
		return await this.safeExecute("clearHistory", async () => {
			this.assertProfileId(profileId);
			await watchedHistoryRepository.clearForProfile(profileId);
			invalidateProfileCaches(profileId);

			return { success: true };
		});
	}
}

function sumMinutes(rows: Array<{ durationSum: number }>) {
	return rows.reduce((total, row) => total + Math.round(row.durationSum / 60), 0);
}

/** Rounded minutes per metadata id — shared by both insight aggregations. */
function accumulateMinutes(rows: Array<{ metadataId: string; durationSum: number }>): Map<string, number> {
	const totals = new Map<string, number>();
	for (const row of rows) {
		const prev = totals.get(row.metadataId) ?? 0;
		totals.set(row.metadataId, prev + Math.round(row.durationSum / 60));
	}

	return totals;
}

function aggregateMinutesByName(relations: Array<{ metadataId: string; name: string }>, minutes: Map<string, number>): Map<string, number> {
	const totals = new Map<string, number>();
	for (const r of relations) {
		const prev = totals.get(r.name) ?? 0;
		totals.set(r.name, prev + (minutes.get(r.metadataId) ?? 0));
	}

	return totals;
}

function topRelation(relations: Array<{ metadataId: string; name: string }>, minutes: Map<string, number>) {
	return topFromAggregated(aggregateMinutesByName(relations, minutes));
}

function topFromAggregated(aggregated: Map<string, number>) {
	const top = maxBy([...aggregated.entries()], ([, minutes]) => minutes);

	return top ? { name: top[0], minutes: top[1] } : null;
}

function computeGenresDistributionFromAggregated(aggregated: Map<string, number>, totalMinutes: number): GenreDistribution[] {
	const sorted = [...aggregated.entries()].toSorted((a, b) => b[1] - a[1]);

	return sorted.slice(0, 6).map(([name, mins]) => ({
		name,
		minutes: mins,
		percentage: totalMinutes > 0 ? Number(((mins / totalMinutes) * 100).toFixed(1)) : 0,
	}));
}

function computeRankedActors(relations: Array<{ metadataId: string; name: string }>, minutes: Map<string, number>) {
	const aggregated = aggregateMinutesByName(relations, minutes);
	const sorted = [...aggregated.entries()].toSorted((a, b) => b[1] - a[1]);

	return sorted.slice(0, 5).map(([name, mins]) => ({ name, minutes: mins }));
}

function activityByDay(rows: Array<{ day: string | null; durationSum: number }>, days: number, now: Date) {
	const totals = new Map<string, number>();
	for (const row of rows) {
		if (!row.day) continue;

		const prev = totals.get(row.day) ?? 0;
		totals.set(row.day, prev + Math.round(row.durationSum / 60));
	}

	return recentDayKeys(days, now).map((date) => ({ date, minutes: totals.get(date) ?? 0 }));
}

const BINGE_WATCHER_MINUTES = 360;
const CINEPHILE_MINUTES = 5000;

const GENRE_PERSONALITY_RULES: Array<{ genres: string[]; code: string; badge: string }> = [
	{ genres: ["sci-fi", "science"], code: "sci_fi_explorer", badge: "🚀" },
	{ genres: ["drama", "mystery", "crime", "thriller"], code: "mystery_connoisseur", badge: "🔍" },
	{ genres: ["action", "adventure"], code: "adrenaline_hunter", badge: "⚡" },
	{ genres: ["comedy", "animation"], code: "comedy_enthusiast", badge: "🍿" },
];

function getViewerPersonality(
	topGenres: GenreDistribution[],
	totalMinutes: number,
	marathonMinutes: number,
): { code: string; badge: string } {
	const topGenre = topGenres[0]?.name.toLowerCase() ?? "";

	if (marathonMinutes >= BINGE_WATCHER_MINUTES) {
		return { code: "binge_watcher", badge: "🏆" };
	}

	for (const rule of GENRE_PERSONALITY_RULES) {
		for (const g of rule.genres) {
			if (topGenre.includes(g)) return { code: rule.code, badge: rule.badge };
		}
	}

	if (totalMinutes > CINEPHILE_MINUTES) {
		return { code: "cinephile", badge: "🎬" };
	}

	return { code: "curious_viewer", badge: "✨" };
}

export const watchedHistoryService = new WatchedHistoryService();
