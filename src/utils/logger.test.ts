import { afterEach, describe, expect, it, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFile } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { createLogger, DailyRotatingStream, sanitizeLogValue } from "./logger";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DailyRotatingStream", () => {
	it("archives the active file when the date changes", async () => {
		const directory = await mkdtemp(PathUtils.join("/tmp", "reelvault-log-"));
		temporaryDirectories.push(directory);
		const activePath = PathUtils.join(directory, "reelvault.log");
		let date = "2026-08-01";
		const stream = new DailyRotatingStream(activePath, () => date);

		await write(stream, "first\n");
		date = "2026-08-02";
		await write(stream, "second\n");
		stream.end();
		await once(stream, "finish");

		expect(await readFile(PathUtils.join(directory, "2026-08-01", "reelvault.log"), "utf8")).toBe("first\n");
		expect(await readFile(activePath, "utf8")).toBe("second\n");
	});

	it("archives a leftover file from a previous day before opening the active stream", async () => {
		const directory = await mkdtemp(PathUtils.join("/tmp", "reelvault-log-"));
		temporaryDirectories.push(directory);
		const activePath = PathUtils.join(directory, "reelvault.log");
		await writeFile(activePath, "stale\n");
		const { mtimeMs } = await stat(activePath);
		const staleDate = toLocalDateString(mtimeMs);

		// Regression: the startup archive must complete before the write stream
		// opens — otherwise the rename moves the just-opened inode into the
		// archive and the active path never exists again.
		const stream = new DailyRotatingStream(activePath, () => "2030-01-01");
		await write(stream, "fresh\n");
		stream.end();
		await once(stream, "finish");

		expect(await readFile(PathUtils.join(directory, staleDate, "reelvault.log"), "utf8")).toBe("stale\n");
		expect(await readFile(activePath, "utf8")).toBe("fresh\n");
	});
});

function write(stream: DailyRotatingStream, value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(value, (error) => (error ? reject(error) : resolve()));
	});
}

function toLocalDateString(timestampMs: number): string {
	const date = new Date(timestampMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${date.getFullYear()}-${month}-${day}`;
}

test("AppLogger accepts every level and message shape without throwing", () => {
	const log = createLogger("TestLogger");

	const err = new Error("Sample error");
	expect(() => log.error("An error occurred", err, { context: "unit-test" })).not.toThrow();
	expect(() => log.error("An error occurred without error object", { context: "unit-test" })).not.toThrow();
	expect(() => log.warn("Warning", { foo: "bar" })).not.toThrow();
	expect(() => log.info("Informational log", { foo: "bar" })).not.toThrow();
	expect(() => log.debug("Debug detail")).not.toThrow();
});

test("sanitizeLogValue redacts credentials and filesystem locations", () => {
	const safe = sanitizeLogValue({
		authorization: "Bearer secret-token",
		password: "super-secret",
		nested: { accessToken: "another-secret", status: "failed" },
	}) as Record<string, unknown>;

	expect(safe).toEqual({
		authorization: "[REDACTED]",
		password: "[REDACTED]",
		nested: { accessToken: "[REDACTED]", status: "failed" },
	});
});

test("sanitizeLogValue returns clean payloads by reference without cloning benign keyword strings", () => {
	const payload = {
		keys: ["keyboard", "keyup", "Enter"],
		note: "token refresh scheduled",
		nested: { hint: "the key to success" },
	};

	expect(sanitizeLogValue(payload)).toBe(payload);
});

test("sanitizeLogValue does not treat a bare 'key' field as sensitive", () => {
	const payload = { key: "x" };

	expect(sanitizeLogValue(payload)).toBe(payload);
});

test("sanitizeLogValue redacts Bearer and kw= forms in nested values", () => {
	const safe = sanitizeLogValue({
		context: "request failed",
		detail: "Authorization: Bearer abc.def",
		query: "password=hunter2&user=ada",
	}) as Record<string, unknown>;

	expect(safe).toEqual({
		context: "request failed",
		detail: "Authorization: Bearer [REDACTED]",
		query: "password=[REDACTED]&user=ada",
	});
});

test("sanitizeLogValue redacts case variants of credential assignments", () => {
	const safe = sanitizeLogValue({
		query: "PASSWORD=hunter2&user=ada",
		header: "BEARER abc.def",
		benign: "Keyboard shortcuts",
	}) as Record<string, unknown>;

	expect(safe).toEqual({
		query: "PASSWORD=[REDACTED]&user=ada",
		header: "BEARER [REDACTED]",
		benign: "Keyboard shortcuts",
	});
});

test("sanitizeLogValue leaves benign keyword strings untouched inside a redacted payload", () => {
	const safe = sanitizeLogValue({
		authorization: "Bearer secret",
		note: "keyboard",
		tag: "token refresh scheduled",
	}) as Record<string, unknown>;

	expect(safe).toEqual({
		authorization: "[REDACTED]",
		note: "keyboard",
		tag: "token refresh scheduled",
	});
});

test("sanitizeLogValue redacts an Error cause chain", () => {
	const inner = new Error("connect failed password=hunter2");
	const outer = new Error("outer failed", { cause: inner });
	const safe = sanitizeLogValue(outer);

	expect(safe).toMatchObject({
		name: "Error",
		message: "outer failed",
		cause: {
			name: "Error",
			message: "connect failed password=[REDACTED]",
		},
	});
	expect(typeof safe.stack).toBe("string");
});

test("sanitizeLogValue marks cycles when redacting", () => {
	const node: Record<string, unknown> = { name: "root", detail: "Bearer cyc" };
	node.self = node;
	const safe = sanitizeLogValue(node);

	expect(safe).toEqual({
		name: "root",
		detail: "Bearer [REDACTED]",
		self: "[Circular]",
	});
});

test("sanitizeLogValue returns a clean cyclic payload by reference", () => {
	const node: Record<string, unknown> = { name: "root", count: 2 };
	node.self = node;

	expect(sanitizeLogValue(node)).toBe(node);
});

test("sanitizeLogValue replaces subtrees past the max depth when redaction runs", () => {
	const payload: Record<string, unknown> = { auth: "Bearer abc" };
	let cursor = payload;
	for (let i = 0; i < 9; i += 1) {
		const child: Record<string, unknown> = {};
		cursor.deep = child;
		cursor = child;
	}

	cursor.leaf = "value";

	const safe = sanitizeLogValue(payload);
	expect(safe.auth).toBe("Bearer [REDACTED]");

	let walked: unknown = safe;
	for (let i = 0; i < 8; i += 1) {
		walked = (walked as Record<string, unknown>).deep;
	}

	expect(walked).toBe("[MaxDepth]");
});
