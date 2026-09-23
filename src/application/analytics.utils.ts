import type { HourlyHeatmapPoint } from "@reelvault/sdk/common";
import { DAY } from "@/server.constants";

/** Daily buckets both insights views render — older activity is dropped. */
const MAX_DAILY_BUCKETS = 30;

/** 7×24 grid of watched minutes from per-(day, hour) rows. */
export function buildHourlyHeatmap(rows: ReadonlyArray<{ dayOfWeek: number; hour: number; minutes: number }>): HourlyHeatmapPoint[] {
	const grid: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

	for (const row of rows) {
		const dayRow = grid[row.dayOfWeek];
		if (dayRow) dayRow[row.hour] = (dayRow[row.hour] ?? 0) + row.minutes;
	}

	const points: HourlyHeatmapPoint[] = [];
	for (let day = 0; day < 7; day++) {
		for (let hour = 0; hour < 24; hour++) {
			points.push({ dayOfWeek: day, hour, minutes: grid[day]?.[hour] ?? 0 });
		}
	}

	return points;
}

/** `en-CA` (YYYY-MM-DD) keys for the most recent days, oldest first, capped at 30. */
export function recentDayKeys(days: number, now: Date): string[] {
	const formatter = new Intl.DateTimeFormat("en-CA");
	const count = Math.min(days, MAX_DAILY_BUCKETS);

	return Array.from({ length: count }, (_, index) => formatter.format(new Date(now.getTime() - (count - 1 - index) * DAY)));
}
