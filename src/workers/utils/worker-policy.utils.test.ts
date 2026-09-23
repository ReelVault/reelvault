import { describe, expect, it } from "bun:test";
import { assertCronExpression, computeNextRunAt, getRetryDelay, matchesCron } from "@/workers/utils/worker-policy.utils";

describe("queue policy", () => {
	it("calculates fixed and exponential retry delays", () => {
		expect(getRetryDelay({ attempts: 3, backoffType: "fixed", backoffDelayMs: 1000 })).toBe(1000);
		expect(getRetryDelay({ attempts: 1, backoffType: "exponential", backoffDelayMs: 1000 })).toBe(1000);
		expect(getRetryDelay({ attempts: 3, backoffType: "exponential", backoffDelayMs: 1000 })).toBe(4000);
	});

	it("matches five-field local cron expressions", () => {
		expect(matchesCron(new Date(2026, 6, 24, 3, 0), "0 3 * * 5")).toBe(true);
		expect(matchesCron(new Date(2026, 6, 24, 3, 7), "0 3 * * 5")).toBe(false);
		expect(matchesCron(new Date(2026, 6, 24, 3, 15), "*/15 * * * *")).toBe(true);
	});

	it("rejects malformed cron expressions", () => {
		expect(() => matchesCron(new Date(), "0 3 * *")).toThrow("Invalid cron expression");
		expect(() => assertCronExpression("0 24 * * *")).toThrow("Invalid cron expression");
		expect(() => assertCronExpression("*/0 * * * *")).toThrow("Invalid cron expression");
	});
});

describe("getRetryDelay edge cases", () => {
	it("fixed backoff ignores attempt count", () => {
		expect(getRetryDelay({ attempts: 0, backoffType: "fixed", backoffDelayMs: 500 })).toBe(500);
		expect(getRetryDelay({ attempts: 10, backoffType: "fixed", backoffDelayMs: 500 })).toBe(500);
	});

	it("exponential backoff grows correctly at high attempt counts", () => {
		expect(getRetryDelay({ attempts: 1, backoffType: "exponential", backoffDelayMs: 1000 })).toBe(1000);
		expect(getRetryDelay({ attempts: 5, backoffType: "exponential", backoffDelayMs: 1000 })).toBe(16000);
		expect(getRetryDelay({ attempts: 10, backoffType: "exponential", backoffDelayMs: 1000 })).toBe(512000);
	});

	it("zero delay returns zero for both backoff types", () => {
		expect(getRetryDelay({ attempts: 1, backoffType: "fixed", backoffDelayMs: 0 })).toBe(0);
		expect(getRetryDelay({ attempts: 5, backoffType: "exponential", backoffDelayMs: 0 })).toBe(0);
	});
});

describe("matchesCron step values", () => {
	it("matches minute steps with */N", () => {
		expect(matchesCron(new Date(2026, 0, 1, 0, 0), "*/5 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 5), "*/5 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 3), "*/5 * * * *")).toBe(false);
	});

	it("matches range with step (1-10/2)", () => {
		expect(matchesCron(new Date(2026, 0, 1, 0, 1), "1-10/2 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 3), "1-10/2 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 4), "1-10/2 * * * *")).toBe(false);
		expect(matchesCron(new Date(2026, 0, 1, 0, 11), "1-10/2 * * * *")).toBe(false);
	});

	it("matches comma-separated values", () => {
		expect(matchesCron(new Date(2026, 0, 1, 0, 1), "1,3,5 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 3), "1,3,5 * * * *")).toBe(true);
		expect(matchesCron(new Date(2026, 0, 1, 0, 2), "1,3,5 * * * *")).toBe(false);
	});

	it("matches day-of-week correctly (0=Sunday, 6=Saturday)", () => {
		expect(matchesCron(new Date(2026, 6, 26, 0, 0), "* * * * 0")).toBe(true);
		expect(matchesCron(new Date(2026, 6, 25, 0, 0), "* * * * 6")).toBe(true);
		expect(matchesCron(new Date(2026, 6, 24, 0, 0), "* * * * 5")).toBe(true);
	});

	it("ORs day-of-month and day-of-week when both are restricted", () => {
		// "0 0 1 * 1" = the 1st of the month OR Mondays.
		const firstNotMonday = new Date(2026, 8, 1, 0, 0); // 2026-09-01 (Tuesday)
		const mondayNotFirst = new Date(2026, 8, 7, 0, 0); // 2026-09-07 (Monday)
		const neither = new Date(2026, 8, 2, 0, 0); // Wednesday the 2nd
		expect(firstNotMonday.getDay()).not.toBe(1);
		expect(mondayNotFirst.getDate()).not.toBe(1);
		expect(matchesCron(firstNotMonday, "0 0 1 * 1")).toBe(true);
		expect(matchesCron(mondayNotFirst, "0 0 1 * 1")).toBe(true);
		expect(matchesCron(neither, "0 0 1 * 1")).toBe(false);
	});
});

describe("assertCronExpression boundary validation", () => {
	it("rejects hour = 24", () => {
		expect(() => assertCronExpression("0 24 * * *")).toThrow("Invalid cron expression");
	});

	it("rejects day = 0", () => {
		expect(() => assertCronExpression("0 0 0 * *")).toThrow("Invalid cron expression");
	});

	it("rejects day = 32", () => {
		expect(() => assertCronExpression("0 0 32 * *")).toThrow("Invalid cron expression");
	});

	it("rejects month = 0", () => {
		expect(() => assertCronExpression("0 0 * 0 *")).toThrow("Invalid cron expression");
	});

	it("rejects month = 13", () => {
		expect(() => assertCronExpression("0 0 * 13 *")).toThrow("Invalid cron expression");
	});

	it("rejects day-of-week = 7", () => {
		expect(() => assertCronExpression("0 0 * * 7")).toThrow("Invalid cron expression");
	});

	it("rejects more than 5 fields", () => {
		expect(() => assertCronExpression("* * * * * *")).toThrow("Invalid cron expression");
	});

	it("rejects fewer than 5 fields", () => {
		expect(() => assertCronExpression("* * * *")).toThrow("Invalid cron expression");
	});

	it("rejects non-numeric step", () => {
		expect(() => assertCronExpression("*/abc * * * *")).toThrow("Invalid cron expression");
	});

	it("rejects step = 0", () => {
		expect(() => assertCronExpression("*/0 * * * *")).toThrow("Invalid cron expression");
	});

	it("accepts valid expressions", () => {
		expect(() => assertCronExpression("0 0 * * *")).not.toThrow();
		expect(() => assertCronExpression("*/15 * * * *")).not.toThrow();
		expect(() => assertCronExpression("0 3 * * 1-5")).not.toThrow();
		expect(() => assertCronExpression("30 2 1,15 * *")).not.toThrow();
	});
});

describe("computeNextRunAt", () => {
	const triggers = (type: string, extra: Record<string, unknown>) => [
		{ id: "t", type, ...extra } as unknown as Parameters<typeof computeNextRunAt>[0][number],
	];

	it("advances interval triggers to the next wall-clock multiple", () => {
		// 60-min interval: any time inside 03:00-03:59 → next fire at 04:00.
		const from = new Date(2026, 8, 15, 3, 17);
		const next = computeNextRunAt(triggers("interval", { intervalMinutes: 60 }), undefined, from);
		expect(next?.getHours()).toBe(4);
		expect(next?.getMinutes()).toBe(0);
		expect(next?.getTime()).toBeGreaterThan(from.getTime());
	});

	it("returns the next daily occurrence, tomorrow when today already passed", () => {
		const from = new Date(2026, 8, 15, 14, 0);
		const next = computeNextRunAt(triggers("daily", { timeOfDay: "03:30" }), undefined, from);
		expect(next?.getDate()).toBe(16);
		expect(next?.getHours()).toBe(3);
		expect(next?.getMinutes()).toBe(30);
	});

	it("daily fires later today when the time is still ahead", () => {
		const from = new Date(2026, 8, 15, 1, 0);
		const next = computeNextRunAt(triggers("daily", { timeOfDay: "03:30" }), undefined, from);
		expect(next?.getDate()).toBe(15);
		expect(next?.getHours()).toBe(3);
	});

	it("finds the next matching weekday for weekly triggers", () => {
		// 2026-09-15 is a Tuesday; next Wednesday 09:00 is 2026-09-16.
		const from = new Date(2026, 8, 15, 12, 0);
		const next = computeNextRunAt(triggers("weekly", { timeOfDay: "09:00", dayOfWeek: 3 }), undefined, from);
		expect(next?.getDay()).toBe(3);
		expect(next?.getDate()).toBe(16);
		expect(next?.getHours()).toBe(9);
	});

	it("picks the earliest across triggers, cron included", () => {
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

	it("returns null when no schedulable trigger exists", () => {
		expect(computeNextRunAt(triggers("startup", {}), undefined, new Date())).toBeNull();
		expect(computeNextRunAt([], undefined, new Date())).toBeNull();
	});
});
