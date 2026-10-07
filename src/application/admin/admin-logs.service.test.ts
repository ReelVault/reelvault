import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminLogsService } from "@/application/admin/admin-logs.service";
import { serverConfig } from "@/server.config";
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
});
