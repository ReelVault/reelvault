import { afterEach, beforeEach, expect, test } from "bun:test";
import { DatabaseQueryLogger } from "./query-logger";

let logger: DatabaseQueryLogger;

beforeEach(() => {
	logger = new DatabaseQueryLogger({ enabled: true, slowThresholdMs: 50 });
});

afterEach(() => {
	logger.resetStats();
});

test("logs query and tracks count when enabled", async () => {
	logger.logQuery("SELECT * FROM users WHERE id = ?", [1]);
	logger.recordQuery("SELECT * FROM users WHERE id = ?", [1], 5);
	// One macrotask flushes every pending microtask (async log writes).
	await new Promise((resolve) => {
		setImmediate(resolve);
	});

	const stats = logger.getStats();
	expect(stats.queryCount).toBe(1);
	expect(stats.slowQueryCount).toBe(0);
});

test("does not log when disabled", async () => {
	const disabled = new DatabaseQueryLogger({ enabled: false });
	disabled.logQuery("SELECT 1", []);
	disabled.recordQuery("SELECT 1", [], 10);
	await new Promise((resolve) => {
		setImmediate(resolve);
	});

	expect(disabled.getStats().queryCount).toBe(0);
});

test("tracks slow queries exceeding threshold", () => {
	const slow = new DatabaseQueryLogger({ enabled: true, slowThresholdMs: 0 });

	slow.logQuery("SELECT pg_sleep(1)", []);
	slow.recordQuery("SELECT pg_sleep(1)", [], 1);

	expect(slow.getStats().queryCount).toBe(1);
	expect(slow.getStats().slowQueryCount).toBe(1);
});

test("resetStats clears counters", () => {
	logger.logQuery("SELECT 1", []);
	logger.logQuery("SELECT 2", []);
	logger.recordQuery("SELECT 2", [], 200);

	expect(logger.getStats().queryCount).toBe(2);
	expect(logger.getStats().slowQueryCount).toBe(1);

	logger.resetStats();
	expect(logger.getStats().queryCount).toBe(0);
	expect(logger.getStats().slowQueryCount).toBe(0);
});

test("defaults to disabled", () => {
	const defaultLogger = new DatabaseQueryLogger();
	defaultLogger.logQuery("SELECT 1", []);
	defaultLogger.recordQuery("SELECT 1", [], 10);

	expect(defaultLogger.getStats().queryCount).toBe(0);
	expect(defaultLogger.getStats().slowQueryCount).toBe(0);
});
