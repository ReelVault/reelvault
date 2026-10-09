import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { adminLogsService } from "@/application/admin/admin-logs.service";
import { serverConfig } from "@/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";

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
		logPath = PathUtils.join(testLogsDir, "reelvault.log");
		await writeFile(logPath, Array.from({ length: 20 }, (_, index) => jsonLine(`line-${index}`)).join(""));
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await rm(testLogsDir, { recursive: true, force: true });
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

		const search = await adminLogsService.getLogs({ fileId: "reelvault.log", search: "boom", limit: 5 });
		expect(search.data).toHaveLength(1);
	});

	test("reports the served window for a file larger than the tail window", async () => {
		await writeFile(logPath, jsonLine("bulk").repeat(40_000));

		const page = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });

		expect(page.truncated).toBe(true);
		expect(page.windowBytes).toBeGreaterThan(0);
	});

	test("reports no window for a file that fits", async () => {
		const page = await adminLogsService.getLogs({ fileId: "reelvault.log", limit: 5 });

		expect(page.truncated).toBe(false);
	});
});

describe("AdminService log bundle", () => {
	let testLogsDir: string;
	let originalLogsPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-bundle-"));
		serverConfig.paths.logs = testLogsDir;
		await writeFile(PathUtils.join(testLogsDir, "reelvault.log"), jsonLine("main"));
		await DirUtils.create(PathUtils.join(testLogsDir, "ffmpeg"));
		await writeFile(PathUtils.join(testLogsDir, "ffmpeg", "transcode-1.log"), "transcode line\n");
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await rm(testLogsDir, { recursive: true, force: true });
	});

	test("packs every log file into a single zip", async () => {
		const { data, filename } = await adminLogsService.getLogBundle();

		expect(filename).toStartWith("reelvault-logs-");
		expect(Object.keys(unzipSync(data)).toSorted()).toEqual(["ffmpeg/transcode-1.log", "reelvault.log"]);
	});
});
