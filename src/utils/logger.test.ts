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
