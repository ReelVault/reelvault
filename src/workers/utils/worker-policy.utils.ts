import type { TaskTrigger } from "@sdk/common";
import type { BackoffType } from "@sdk/plugin";
import { MINUTE } from "@/server.constants";
import { ValidationError } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";

export function getRetryDelay({
	attempts,
	backoffType,
	backoffDelayMs,
}: {
	attempts: number;
	backoffType: BackoffType;
	backoffDelayMs: number;
}): number {
	if (backoffType === "fixed") return backoffDelayMs;

	return backoffDelayMs * 2 ** Math.max(0, attempts - 1);
}

type CompiledCronField = (value: number) => boolean;
/** Cron expressions come from worker definitions and persisted triggers — bound the compiled cache. */
const cronCache = new MemoryCache<CompiledCron>({ ttlMs: -1, maxSize: 256, name: "cron" });
const cronFieldSeparator = /\s+/;
const cronStepPattern = /^\d+$/;
const CRON_RANGES: ReadonlyArray<[number, number]> = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 6],
];

function compileCronField(field: string, min: number, max: number): CompiledCronField {
	assertCronField(field, min, max, "(compiled)");
	const parts = field.split(",").map((part) => {
		const [rangePart, stepPart] = part.split("/");
		const step = stepPart ? Number(stepPart) : 1;
		const range = rangePart === "*" || !rangePart ? [min, max] : rangePart.split("-").map(Number);
		const start = range[0] ?? min;
		const end = range[1] ?? start;

		return { start, end, step };
	});

	return (value: number) => parts.some(({ start, end, step }) => value >= start && value <= end && (value - start) % step === 0);
}

type CompiledCron = [CompiledCronField, CompiledCronField, CompiledCronField, CompiledCronField, CompiledCronField];

function compileCron(expression: string): CompiledCron {
	const cached = cronCache.get(expression);
	if (cached !== null) return cached;

	assertCronExpression(expression);
	const fields = expression.trim().split(cronFieldSeparator);
	const compiled: CompiledCron = [
		compileCronField(fields[0] ?? "", CRON_RANGES[0]?.[0] ?? 0, CRON_RANGES[0]?.[1] ?? 59),
		compileCronField(fields[1] ?? "", CRON_RANGES[1]?.[0] ?? 0, CRON_RANGES[1]?.[1] ?? 59),
		compileCronField(fields[2] ?? "", CRON_RANGES[2]?.[0] ?? 0, CRON_RANGES[2]?.[1] ?? 59),
		compileCronField(fields[3] ?? "", CRON_RANGES[3]?.[0] ?? 0, CRON_RANGES[3]?.[1] ?? 59),
		compileCronField(fields[4] ?? "", CRON_RANGES[4]?.[0] ?? 0, CRON_RANGES[4]?.[1] ?? 59),
	];
	cronCache.set(expression, compiled);

	return compiled;
}

export function matchesCron(date: Date, expression: string): boolean {
	const rawFields = expression.trim().split(cronFieldSeparator);
	const [minute, hour, day, month, weekday] = compileCron(expression);
	const domMatch = day(date.getDate());
	const dowMatch = weekday(date.getDay());

	return minute(date.getMinutes()) && hour(date.getHours()) && cronDayMatches(rawFields, domMatch, dowMatch) && month(date.getMonth() + 1);
}

/**
 * Standard cron day semantics: when BOTH day-of-month and day-of-week are
 * restricted (not `*`), a day matches if EITHER does; otherwise both must match.
 */
function cronDayMatches(rawFields: string[], domMatch: boolean, dowMatch: boolean): boolean {
	const dayRestricted = !(rawFields[2] ?? "*").trim().startsWith("*");
	const weekdayRestricted = !(rawFields[4] ?? "*").trim().startsWith("*");
	if (dayRestricted && weekdayRestricted) return domMatch || dowMatch;

	return domMatch && dowMatch;
}

export function assertCronExpression(expression: string): void {
	const fields = expression.trim().split(cronFieldSeparator);
	if (fields.length !== 5) throw new ValidationError(`Invalid cron expression: ${expression}`);

	for (const [index, field] of fields.entries()) {
		const range = CRON_RANGES[index];
		if (!range) throw new ValidationError(`Invalid cron expression: ${expression}`);

		assertCronField(field, range[0], range[1], expression);
	}
}

function assertCronField(field: string, min: number, max: number, expression: string): void {
	for (const part of field.split(",")) {
		const [rangePart, stepPart, extraPart] = part.split("/");
		if (!rangePart || extraPart) throw new ValidationError(`Invalid cron expression: ${expression}`);

		if (stepPart && (!cronStepPattern.test(stepPart) || Number(stepPart) < 1))
			throw new ValidationError(`Invalid cron expression: ${expression}`);

		if (rangePart === "*") continue;

		const range = rangePart.split("-");
		if (range.length > 2 || !range.every((value) => cronStepPattern.test(value))) {
			throw new ValidationError(`Invalid cron expression: ${expression}`);
		}

		const start = Number(range[0]);
		const end = Number(range[1] ?? range[0]);
		if (start < min || end > max || start > end) throw new ValidationError(`Invalid cron expression: ${expression}`);
	}
}

/**
 * Next fire time STRICTLY AFTER `from` for the given triggers plus an optional
 * definition-level cron, or null when nothing can ever fire. Interval triggers
 * stay wall-clock aligned (epoch-minute multiples).
 */
export function computeNextRunAt(triggers: TaskTrigger[], cron: string | undefined, from: Date): Date | null {
	const candidates = triggers.map((trigger) => nextTriggerCandidate(trigger, from)).filter((candidate) => candidate !== null);
	const cronMatch = cron ? nextCronMatch(from, cron) : null;
	if (cronMatch) candidates.push(cronMatch);

	if (candidates.length === 0) return null;

	return new Date(Math.min(...candidates.map((candidate) => candidate.getTime())));
}

function nextTriggerCandidate(trigger: TaskTrigger, from: Date): Date | null {
	switch (trigger.type) {
		case "interval": {
			if (!trigger.intervalMinutes || trigger.intervalMinutes <= 0) return null;

			// Next epoch-minute multiple of the interval, strictly after `from` —
			// keeps the wall-clock alignment the old minute-matcher used.
			const fromMinute = Math.floor(from.getTime() / MINUTE);
			const nextMultiple = (Math.floor(fromMinute / trigger.intervalMinutes) + 1) * trigger.intervalMinutes;

			return new Date(nextMultiple * MINUTE);
		}
		case "daily": {
			if (!trigger.timeOfDay) return null;

			const { hours, minutes } = parseTimeOfDay(trigger.timeOfDay);
			const candidate = new Date(from);
			candidate.setHours(hours, minutes, 0, 0);
			if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);

			return candidate;
		}
		case "weekly": {
			if (!trigger.timeOfDay || trigger.dayOfWeek === undefined) return null;

			const { hours, minutes } = parseTimeOfDay(trigger.timeOfDay);
			for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
				const candidate = new Date(from);
				candidate.setDate(candidate.getDate() + dayOffset);
				candidate.setHours(hours, minutes, 0, 0);
				if (candidate.getTime() > from.getTime() && candidate.getDay() === trigger.dayOfWeek) {
					return candidate;
				}
			}

			return null;
		}
		case "startup":
			return null;
		default:
			return null;
	}
}

function nextCronMatch(from: Date, cron: string): Date | null {
	const rawFields = cron.trim().split(cronFieldSeparator);
	const [minuteField, hourField, dayField, monthField, weekdayField] = compileCron(cron);
	const validMinutes = [...extractValidValues(minuteField, 0, 59)].toSorted((a, b) => a - b);
	const validHours = [...extractValidValues(hourField, 0, 23)].toSorted((a, b) => a - b);
	const validDays = extractValidValues(dayField, 1, 31);
	const validMonths = extractValidValues(monthField, 1, 12);
	const validWeekdays = extractValidValues(weekdayField, 0, 6);
	if (validMinutes.length === 0 || validHours.length === 0) return null;

	// Day-level scan (covers leap years) then the first valid time within the day —
	// avoids the previous 527k minute-by-minute scan for every tick, including
	// expressions that can never match.
	const MAX_LOOKAHEAD_DAYS = 366 * 4 + 1;
	const startOfDay = new Date(from);
	startOfDay.setHours(0, 0, 0, 0);

	for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset++) {
		const day = new Date(startOfDay);
		day.setDate(day.getDate() + dayOffset);
		const domMatch = validDays.has(day.getDate());
		const dowMatch = validWeekdays.has(day.getDay());
		if (!cronDayMatches(rawFields, domMatch, dowMatch)) continue;

		if (!validMonths.has(day.getMonth() + 1)) continue;

		for (const hours of validHours) {
			for (const minutes of validMinutes) {
				const candidate = new Date(day);
				candidate.setHours(hours, minutes, 0, 0);
				if (candidate.getTime() > from.getTime()) return candidate;
			}
		}
	}

	return null;
}

function extractValidValues(field: CompiledCronField, min: number, max: number): Set<number> {
	const result = new Set<number>();
	for (let i = min; i <= max; i++) {
		if (field(i)) result.add(i);
	}

	return result;
}

function parseTimeOfDay(value: string): { hours: number; minutes: number } {
	const [h = 0, m = 0] = value.split(":").map(Number);

	return { hours: h, minutes: m };
}
