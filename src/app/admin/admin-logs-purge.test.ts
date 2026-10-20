import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminLogsService } from "@/app/admin/admin-logs.service";
import { serverConfig } from "@/config/server/server.config";
import { daysAgo } from "@/config/server/server.constants";
import { createDirectory, removeTree } from "@/utils/directory.utils";
import { fileExists, writeFile } from "@/utils/file.utils";

describe("AdminService purgeOldLogs", () => {
	let testLogsDir: string;
	let originalLogsPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-test-"));
		serverConfig.paths.logs = testLogsDir;
		await createDirectory(join(testLogsDir, "ffmpeg"));
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await removeTree(testLogsDir);
	});

	test("a dry run counts the log files a purge would remove and removes none", async () => {
		const oldLog = join(testLogsDir, "ffmpeg", "old.log");
		await writeFile(oldLog, "old logs");
		const tenDaysAgo = daysAgo(10);
		await utimes(oldLog, tenDaysAgo, tenDaysAgo);

		const result = await adminLogsService.purgeOldLogs(7, undefined, undefined, true);

		expect(result.deletedCount).toBe(1);
		expect(result.freedBytes).toBe(Buffer.byteLength("old logs"));
		expect(await fileExists(oldLog)).toBe(true);
	});

	test("purges log files older than specified retention days", async () => {
		const recentLog = join(testLogsDir, "ffmpeg", "recent.log");
		const oldLog = join(testLogsDir, "ffmpeg", "old.log");

		await writeFile(recentLog, "recent logs");
		await writeFile(oldLog, "old logs");

		const tenDaysAgo = daysAgo(10);
		await utimes(oldLog, tenDaysAgo, tenDaysAgo);

		const result = await adminLogsService.purgeOldLogs(7);

		expect(result.deletedCount).toBe(1);
		expect(result.retentionDays).toBe(7);
		expect(await fileExists(recentLog)).toBe(true);
		expect(await fileExists(oldLog)).toBe(false);
	});
});
