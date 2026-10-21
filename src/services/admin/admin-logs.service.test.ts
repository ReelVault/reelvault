import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { serverConfig } from "@/config/server/server.config";
import { adminLogsService } from "@/services/admin/admin-logs.service";
import { createDirectory, removeTree } from "@/utils/directory.utils";

function jsonLine(message: string): string {
	return `${JSON.stringify({ level: 30, time: Date.now(), msg: message, module: "Test" })}\n`;
}

describe("AdminService getLogs tail cache", () => {
	let testLogsDir: string;
	let originalLogsPath: string;
	let logPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-tail-"));
		serverConfig.paths.logs = testLogsDir;
		logPath = join(testLogsDir, "reelvault.log");
		await writeFile(logPath, Array.from({ length: 20 }, (_, index) => jsonLine(`line-${index}`)).join(""));
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await removeTree(testLogsDir);
	});

	test("serves appended lines from the incremental path", async () => {
		const first = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });
		expect(first.data[0]).toMatchObject({ msg: "line-19" });

		await appendFile(logPath, jsonLine("line-newest"));

		const second = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });
		expect(second.data[0]).toMatchObject({ msg: "line-newest" });
	});

	test("rebuilds from the window after the file rotates (shrinks)", async () => {
		await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });

		await writeFile(logPath, jsonLine("fresh-after-rotation"));

		const afterRotation = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });
		expect(afterRotation.data).toHaveLength(1);
		expect(afterRotation.data[0]).toMatchObject({ msg: "fresh-after-rotation" });
	});

	test("filters by level and search on the cached tail", async () => {
		await appendFile(logPath, `${JSON.stringify({ level: 50, time: Date.now(), msg: "boom", module: "Test" })}\n`);

		const errors = await adminLogsService.getLogs({ fileId: "reelvault.log", level: "error", limit: 5 });
		expect(errors.data).toHaveLength(1);
		expect(errors.data[0]).toMatchObject({ msg: "boom", levelName: "error" });

		const search = await adminLogsService.getLogs({ fileId: "reelvault.log", q: "boom", limit: 5 });
		expect(search.data).toHaveLength(1);
	});

	test("reports the served window for a file larger than the tail window", async () => {
		await writeFile(logPath, jsonLine("bulk").repeat(40_000));

		const page = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });

		expect(page.truncated).toBe(true);
		expect(page.windowBytes).toBeGreaterThan(0);
	});
});

describe("AdminService log bundle", () => {
	let testLogsDir: string;
	let originalLogsPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-bundle-"));
		serverConfig.paths.logs = testLogsDir;
		await writeFile(join(testLogsDir, "reelvault.log"), jsonLine("main"));
		await createDirectory(join(testLogsDir, "ffmpeg"));
		await writeFile(join(testLogsDir, "ffmpeg", "transcode-1.log"), "transcode line\n");
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await removeTree(testLogsDir);
	});

	test("packs every log file into a single zip", async () => {
		const { data, filename } = await adminLogsService.getLogBundle();

		expect(filename).toStartWith("reelvault-logs-");
		expect(Object.keys(unzipSync(data)).toSorted()).toEqual(["ffmpeg/transcode-1.log", "reelvault.log"]);
	});
});

describe("AdminService getLogs module, exclude and time filters", () => {
	let testLogsDir: string;
	let originalLogsPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-filters-"));
		serverConfig.paths.logs = testLogsDir;
		const entry = (time: string, module: string, msg: string) => JSON.stringify({ level: 30, time: Date.parse(time), module, msg });
		const lines = [
			entry("2026-10-01T10:00:00Z", "LibraryScanner", "scan started"),
			entry("2026-10-02T10:00:00Z", "LibraryScanner", "scan finished"),
			entry("2026-10-03T10:00:00Z", "DownloadWorker", "download failed"),
			"plain ffmpeg output",
		];
		await writeFile(join(testLogsDir, "reelvault.log"), `${lines.join("\n")}\n`);
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await removeTree(testLogsDir);
	});

	const messagesOf = async (query: Parameters<typeof adminLogsService.getLogs>[0]) =>
		(await adminLogsService.getLogs({ fileId: "reelvault.log", ...query })).data.map((item) => item.msg);

	test("module matches the logging module exactly and ignores case", async () => {
		expect(await messagesOf({ module: "libraryscanner" })).toEqual(["scan finished", "scan started"]);
	});

	test("exclude drops entries whose text matches, ignoring case", async () => {
		expect(await messagesOf({ exclude: "FINISHED" })).toEqual(["plain ffmpeg output", "download failed", "scan started"]);
	});

	test("from and to bound the entries by time and drop plain-text lines", async () => {
		expect(await messagesOf({ from: "2026-10-02T00:00:00Z" })).toEqual(["download failed", "scan finished"]);
		expect(await messagesOf({ to: "2026-10-01T23:59:59Z" })).toEqual(["scan started"]);
		expect(await messagesOf({ from: "2026-10-02T00:00:00Z", to: "2026-10-02T23:59:59Z" })).toEqual(["scan finished"]);
	});
});
