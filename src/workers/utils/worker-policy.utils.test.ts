import { describe, expect, test } from "bun:test";
import { assertCronExpression, computeNextRunAt, getRetryDelay, matchesCron } from "@/workers/utils/worker-policy.utils";

// Cron and wall-clock dates are built with local constructors on purpose: the matcher
// reads local fields, so the expectations hold in every time zone.

describe("getRetryDelay", () => {
	test.each([
		{ label: "fixed backoff", attempts: 3, backoffType: "fixed", delay: 1000, expected: 1000 },
		{ label: "fixed backoff ignores a zero attempt count", attempts: 0, backoffType: "fixed", delay: 500, expected: 500 },
		{ label: "fixed backoff ignores a high attempt count", attempts: 10, backoffType: "fixed", delay: 500, expected: 500 },
		{ label: "exponential backoff on the first attempt", attempts: 1, backoffType: "exponential", delay: 1000, expected: 1000 },
		{ label: "exponential backoff doubles per attempt", attempts: 3, backoffType: "exponential", delay: 1000, expected: 4000 },
		{ label: "exponential backoff at attempt five", attempts: 5, backoffType: "exponential", delay: 1000, expected: 16000 },
		{ label: "exponential backoff at attempt ten", attempts: 10, backoffType: "exponential", delay: 1000, expected: 512000 },
		{ label: "zero base delay stays zero for fixed backoff", attempts: 1, backoffType: "fixed", delay: 0, expected: 0 },
		{ label: "zero base delay stays zero for exponential backoff", attempts: 5, backoffType: "exponential", delay: 0, expected: 0 },
	] as const)("$label", ({ attempts, backoffType, delay, expected }) => {
		expect(getRetryDelay({ attempts, backoffType, backoffDelayMs: delay })).toBe(expected);
	});
});

describe("matchesCron", () => {
	test.each([
		{ label: "matches a weekday at a fixed time", date: new Date(2026, 6, 24, 3, 0), expr: "0 3 * * 5", expected: true },
		{ label: "rejects a minute the expression does not list", date: new Date(2026, 6, 24, 3, 7), expr: "0 3 * * 5", expected: false },
		{ label: "matches a quarter-hour step on a quarter hour", date: new Date(2026, 6, 24, 3, 15), expr: "*/15 * * * *", expected: true },
		{ label: "matches a minute step on its multiples", date: new Date(2026, 0, 1, 0, 5), expr: "*/5 * * * *", expected: true },
		{ label: "rejects a minute between minute steps", date: new Date(2026, 0, 1, 0, 3), expr: "*/5 * * * *", expected: false },
		{ label: "matches the start of a stepped range", date: new Date(2026, 0, 1, 0, 1), expr: "1-10/2 * * * *", expected: true },
		{ label: "matches a stepped range inside the range", date: new Date(2026, 0, 1, 0, 3), expr: "1-10/2 * * * *", expected: true },
		{ label: "rejects a stepped range's off-step minute", date: new Date(2026, 0, 1, 0, 4), expr: "1-10/2 * * * *", expected: false },
		{ label: "rejects a stepped range's minute past its end", date: new Date(2026, 0, 1, 0, 11), expr: "1-10/2 * * * *", expected: false },
		{ label: "matches a comma-separated value", date: new Date(2026, 0, 1, 0, 3), expr: "1,3,5 * * * *", expected: true },
		{
			label: "rejects a minute absent from a comma-separated list",
			date: new Date(2026, 0, 1, 0, 2),
			expr: "1,3,5 * * * *",
			expected: false,
		},
		{ label: "treats 0 as Sunday", date: new Date(2026, 6, 26, 0, 0), expr: "* * * * 0", expected: true },
		{ label: "treats 6 as Saturday", date: new Date(2026, 6, 25, 0, 0), expr: "* * * * 6", expected: true },
		{ label: "treats 5 as Friday", date: new Date(2026, 6, 24, 0, 0), expr: "* * * * 5", expected: true },
		// "0 0 1 * 1" = the 1st of the month OR Mondays when both day fields are restricted.
		{
			label: "ORs day-of-month with day-of-week for a first-of-month date",
			date: new Date(2026, 8, 1, 0, 0),
			expr: "0 0 1 * 1",
			expected: true,
		},
		{ label: "ORs day-of-month with day-of-week for a Monday", date: new Date(2026, 8, 7, 0, 0), expr: "0 0 1 * 1", expected: true },
		{ label: "rejects a date matching neither day field", date: new Date(2026, 8, 2, 0, 0), expr: "0 0 1 * 1", expected: false },
	])("$label", ({ date, expr, expected }) => {
		expect(matchesCron(date, expr)).toBe(expected);
	});
});

describe("assertCronExpression", () => {
	test.each([
		{ label: "hour 24 is out of range", expr: "0 24 * * *" },
		{ label: "day 0 is out of range", expr: "0 0 0 * *" },
		{ label: "day 32 is out of range", expr: "0 0 32 * *" },
		{ label: "month 0 is out of range", expr: "0 0 * 0 *" },
		{ label: "month 13 is out of range", expr: "0 0 * 13 *" },
		{ label: "day-of-week 7 is out of range", expr: "0 0 * * 7" },
		{ label: "more than five fields", expr: "* * * * * *" },
		{ label: "fewer than five fields", expr: "* * * *" },
		{ label: "a non-numeric step", expr: "*/abc * * * *" },
		{ label: "a zero step", expr: "*/0 * * * *" },
	])("rejects an expression with $label", ({ expr }) => {
		expect(() => assertCronExpression(expr)).toThrow(expect.objectContaining({ category: "validation", code: "worker.cron_invalid" }));
	});

	test("matchesCron reports the same validation error for a malformed expression", () => {
		expect(() => matchesCron(new Date(), "0 3 * *")).toThrow(
			expect.objectContaining({ category: "validation", code: "worker.cron_invalid" }),
		);
	});

	test("matches the boundary values of every field", () => {
		expect(matchesCron(new Date(2026, 11, 31, 23, 59), "59 23 31 12 *")).toBe(true);
		expect(matchesCron(new Date(2026, 11, 26, 23, 59), "59 23 * 12 6")).toBe(true);
		expect(matchesCron(new Date(2026, 11, 26, 23, 59), "59 23 * 12 0")).toBe(false);
		expect(matchesCron(new Date(2026, 0, 4, 0, 0), "0 0 * 1 0")).toBe(true);
	});
});

describe("computeNextRunAt", () => {
	const triggers = (type: string, extra: Record<string, unknown>) => [
		{ id: "t", type, ...extra } as unknown as Parameters<typeof computeNextRunAt>[0][number],
	];

	test("advances interval triggers to the next wall-clock multiple", () => {
		// 60-min interval: any time inside 03:00-03:59 → next fire at 04:00.
		const from = new Date(2026, 8, 15, 3, 17);
		const next = computeNextRunAt(triggers("interval", { intervalMinutes: 60 }), undefined, from);
		expect(next?.getHours()).toBe(4);
		expect(next?.getMinutes()).toBe(0);
		expect(next?.getTime()).toBeGreaterThan(from.getTime());
	});

	test("returns the next daily occurrence, tomorrow when today already passed", () => {
		const from = new Date(2026, 8, 15, 14, 0);
		const next = computeNextRunAt(triggers("daily", { timeOfDay: "03:30" }), undefined, from);
		expect(next?.getDate()).toBe(16);
		expect(next?.getHours()).toBe(3);
		expect(next?.getMinutes()).toBe(30);
	});

	test("daily fires later today when the time is still ahead", () => {
		const from = new Date(2026, 8, 15, 1, 0);
		const next = computeNextRunAt(triggers("daily", { timeOfDay: "03:30" }), undefined, from);
		expect(next?.getDate()).toBe(15);
		expect(next?.getHours()).toBe(3);
	});

	test("finds the next matching weekday for weekly triggers", () => {
		// 2026-09-15 is a Tuesday; next Wednesday 09:00 is 2026-09-16.
		const from = new Date(2026, 8, 15, 12, 0);
		const next = computeNextRunAt(triggers("weekly", { timeOfDay: "09:00", dayOfWeek: 3 }), undefined, from);
		expect(next?.getDay()).toBe(3);
		expect(next?.getDate()).toBe(16);
		expect(next?.getHours()).toBe(9);
	});

	test("picks the earliest across triggers, cron included", () => {
		const from = new Date(2026, 8, 15, 3, 17);
		const next = computeNextRunAt(
			[...triggers("daily", { timeOfDay: "23:00" }), ...triggers("interval", { intervalMinutes: 60 })],
			"17 4 * * *",
			from,
		);
		// The interval candidate lands exactly on 04:00, beating the 04:17 cron.
		expect(next?.getHours()).toBe(4);
		expect(next?.getMinutes()).toBe(0);
	});

	test("returns null when no schedulable trigger exists", () => {
		expect(computeNextRunAt(triggers("startup", {}), undefined, new Date())).toBeNull();
		expect(computeNextRunAt([], undefined, new Date())).toBeNull();
	});
});
