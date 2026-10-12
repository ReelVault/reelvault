import type { AdminAnalytics, TopWatchedMedia } from "@reelvault/sdk/common";
import { buildHourlyHeatmap, recentDayKeys } from "@/application/analytics.utils";
import { toTopWatchedMedia, watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { serverConfig } from "@/server.config";
import { DAY, MINUTE } from "@/server.constants";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import { MemoryCache } from "@/utils/memory-cache";

const ANALYTICS_CACHE_TTL_MS = MINUTE;
const MAX_ANALYTICS_DAYS = 365;

class AdminAnalyticsService {
	readonly serviceName = "AdminAnalyticsService";
	readonly logger = createLogger("AdminAnalyticsService");

	private readonly cache = new MemoryCache<AdminAnalytics>({ ttlMs: ANALYTICS_CACHE_TTL_MS, maxSize: 32, name: "admin-analytics" });

	async getAnalytics(days?: number): Promise<AdminAnalytics> {
		const clampedDays = days ? clamp(Math.trunc(days), 1, MAX_ANALYTICS_DAYS) : undefined;
		// The minimum is part of the key, so a changed setting shows on the next read instead of after the TTL.
		const minInterruptedSeconds = serverConfig.analytics.minPlaySeconds;
		const cacheKey = `days:${clampedDays ?? "all"}:min:${minInterruptedSeconds}`;

		return await this.cache.getOrSet(cacheKey, async () => {
			const now = new Date();
			// Without an explicit range the dashboard's "all" view uses the
			// configurable look-back instead of an unbounded scan.
			const since = clampedDays
				? new Date(now.getTime() - clampedDays * DAY)
				: new Date(now.getTime() - serverConfig.analytics.windowDays * DAY);

			const [globalData, topContentRaw] = await Promise.all([
				watchedHistoryRepository.findGlobalAnalytics({ since, minInterruptedSeconds }),
				watchedHistoryRepository.findTopPlayedMedia({ since, minInterruptedSeconds, limit: 10 }),
			]);

			const topContent: TopWatchedMedia[] = topContentRaw.map((m) => toTopWatchedMedia(m));

			const hourlyActivity = buildHourlyHeatmap(globalData.hourlyRows);
			const dailyActivity = computeDailyActivity(globalData.dailyRows, clampedDays ?? 30, now);

			return {
				totalWatchMinutes: globalData.totalMinutes,
				totalPlaysCount: globalData.totalPlays,
				completedPlaysCount: globalData.completedPlays,
				activeUsersCount: globalData.activeUsers,
				mostWatchedTitle: topContent[0] ?? null,
				topContent,
				userLeaderboard: globalData.leaderboard.map((u) => ({
					profileId: u.profileId,
					profileName: u.profileName,
					profileAvatar: u.profileAvatar,
					userName: u.userName,
					userEmail: u.userEmail,
					totalMinutes: u.totalMinutes,
					titlesCount: u.titlesCount,
					lastWatchedAt: u.lastWatchedAt ? u.lastWatchedAt.toISOString() : null,
				})),
				recentPlays: globalData.recentPlays.map((p) => ({
					id: p.id,
					profileName: p.profileName,
					userName: p.userName,
					title: p.title,
					mediaType: p.mediaType,
					posterUrl: p.posterImageId ? `${serverConfig.security.imageRoutePrefix}${p.posterImageId}` : null,
					durationWatched: p.durationWatched ? Math.round(p.durationWatched / 60) : null,
					isFullWatch: p.isFullWatch,
					watchedAt: p.watchedAt.toISOString(),
				})),
				hourlyActivity,
				dailyActivity,
			};
		});
	}
}

function computeDailyActivity(rows: Array<{ day: string; minutes: number; playCount: number }>, days: number, now: Date) {
	const totals = new Map<string, { minutes: number; count: number }>();
	for (const row of rows) {
		totals.set(row.day, { minutes: row.minutes, count: row.playCount });
	}

	return recentDayKeys(days, now).map((date) => {
		const item = totals.get(date) ?? { minutes: 0, count: 0 };

		return { date, minutes: item.minutes, playCount: item.count };
	});
}

export const adminAnalyticsService = new AdminAnalyticsService();
