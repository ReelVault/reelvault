import { afterEach, describe, expect, it, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { removeTree } from "@/utils/directory.utils";
import { readFile } from "@/utils/file.utils";
import { formatAccessLine, logAccessRecord } from "./logger.utils";
import { CoalescingStream } from "./logging/coalescing.stream";
import { DailyRotatingStream } from "./logging/daily-rotating.stream";
import { sanitizeLogValue } from "./logging/sanitize.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTree(directory)));
});

describe("DailyRotatingStream", () => {
	it("archives the active file when the date changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-log-"));
		temporaryDirectories.push(directory);
		const activePath = join(directory, "reelvault.log");
		let date = "2026-08-01";
		const stream = new DailyRotatingStream(activePath, () => date);

		await write(stream, "first\n");
		date = "2026-08-02";
		await write(stream, "second\n");
		stream.end();
		await once(stream, "finish");

		expect(await readFile(join(directory, "2026-08-01", "reelvault.log"), "utf8")).toBe("first\n");
		expect(await readFile(activePath, "utf8")).toBe("second\n");
	});

	it("archives a leftover file from a previous day before opening the active stream", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-log-"));
		temporaryDirectories.push(directory);
		const activePath = join(directory, "reelvault.log");
		await writeFile(activePath, "stale\n");
		// The leftover file is dated local noon on 1 August 2026, so its archive folder is a literal.
		const staleMtime = new Date(2026, 7, 1, 12);
		await utimes(activePath, staleMtime, staleMtime);

		// Regression: the startup archive must complete before the write stream
		// opens — otherwise the rename moves the just-opened inode into the
		// archive and the active path never exists again.
		const stream = new DailyRotatingStream(activePath, () => "2030-01-01");
		await write(stream, "fresh\n");
		stream.end();
		await once(stream, "finish");

		expect(await readFile(join(directory, "2026-08-01", "reelvault.log"), "utf8")).toBe("stale\n");
		expect(await readFile(activePath, "utf8")).toBe("fresh\n");
	});

	it("keeps the order of a burst written faster than the file drains", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-log-"));
		temporaryDirectories.push(directory);
		const activePath = join(directory, "reelvault.log");
		const stream = new DailyRotatingStream(activePath, () => "2030-01-01");

		// Synchronous writes without awaiting drain: the backlog is batched through _writev.
		const lines = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
		for (const line of lines) stream.write(line);
		stream.end();
		await once(stream, "finish");

		expect(await readFile(activePath, "utf8")).toBe(lines.join(""));
	});
});

describe("CoalescingStream", () => {
	function collector(): { chunks: string[]; target: Writable } {
		const chunks: string[] = [];
		const target = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				chunks.push(chunk.toString());
				callback();
			},
		});

		return { chunks, target };
	}

	it("batches writes within the flush window into one target write", async () => {
		const { chunks, target } = collector();
		const stream = new CoalescingStream(target);
		stream.write("a\n");
		stream.write("b\n");
		stream.write("c\n");
		stream.end();
		await once(stream, "finish");

		expect(chunks).toEqual(["a\nb\nc\n"]);
	});

	it("flushes without an end after the window passes", async () => {
		const { chunks, target } = collector();
		const stream = new CoalescingStream(target);
		stream.write("x\n");
		await Bun.sleep(20);

		expect(chunks).toEqual(["x\n"]);
		stream.end();
		await once(stream, "finish");
	});

	it("preserves order across a burst and still batches it", async () => {
		const { chunks, target } = collector();
		const stream = new CoalescingStream(target);
		const lines = Array.from({ length: 500 }, (_, index) => `line ${index}\n`);
		for (const line of lines) stream.write(line);
		stream.end();
		await once(stream, "finish");

		expect(chunks.join("")).toBe(lines.join(""));
		expect(chunks.length).toBeLessThan(lines.length);
	});
});

function write(stream: DailyRotatingStream, value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(value, (error) => (error ? reject(error) : resolve()));
	});
}

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
	expect(safe.stack).toBe(outer.stack);
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

const EMPTY_META_ACCESS_LINE = /^\{"level":30,"time":\d+,"module":"Server","module":"RequestLogger","msg":"GET \/ → 200"\}$/;

describe("access log fast path", () => {
	it("serializes the same JSON shape pino emits for the access record", () => {
		const meta = { requestId: "req-1", path: "/v1/metadata", method: "GET", durationMs: 3, status: 200, userId: "user-1" };
		const line = formatAccessLine("GET /v1/metadata → 200", meta);

		// Key order matches pino: level, time, base module, child module, meta, msg.
		expect(line.startsWith('{"level":30,"time":')).toBe(true);
		expect(line).toContain('"module":"Server","module":"RequestLogger"');
		expect(line.endsWith(',"msg":"GET /v1/metadata → 200"}')).toBe(true);
		expect(JSON.parse(line)).toMatchObject({
			level: 30,
			module: "RequestLogger",
			requestId: "req-1",
			path: "/v1/metadata",
			method: "GET",
			durationMs: 3,
			status: 200,
			userId: "user-1",
			msg: "GET /v1/metadata → 200",
		});
	});

	it("omits the meta separator when the record has no fields", () => {
		expect(formatAccessLine("GET / → 200", {})).toMatch(EMPTY_META_ACCESS_LINE);
	});

	it("reports the fast path unavailable while no access sink is installed", () => {
		expect(logAccessRecord("GET / → 200", { path: "/", method: "GET" })).toBe(false);
	});
});
