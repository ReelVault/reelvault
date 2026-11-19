import type { HourlyHeatmapPoint } from "@reelvault/sdk/common";

/** Daily buckets both insights views render — older activity is dropped. */
const MAX_DAILY_BUCKETS = 30;

/** Local calendar day as YYYY-MM-DD. Built from date parts: an Intl formatter fixes its zone when created. */
function localDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${date.getFullYear()}-${month}-${day}`;
}

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
	const count = Math.min(days, MAX_DAILY_BUCKETS);

	// Steps by calendar day: a 24 h step across a DST change lands on the wrong local date and skips one.
	return Array.from({ length: count }, (_, index) => {
		const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1 - index));

		return localDayKey(day);
	});
}
