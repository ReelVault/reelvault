import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminLogsService } from "@/application/admin/admin-logs.service";
import { serverConfig } from "@/server.config";
import { daysAgo } from "@/server.constants";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";

describe("AdminService purgeOldLogs", () => {
	let testLogsDir: string;
	let originalLogsPath: string;

	beforeEach(async () => {
		originalLogsPath = serverConfig.paths.logs;
		testLogsDir = await mkdtemp(join(tmpdir(), "reelvault-admin-logs-test-"));
		serverConfig.paths.logs = testLogsDir;
		await DirUtils.create(join(testLogsDir, "ffmpeg"));
	});

	afterEach(async () => {
		serverConfig.paths.logs = originalLogsPath;
		await rm(testLogsDir, { recursive: true, force: true });
	});

	test("purges log files older than specified retention days", async () => {
		const recentLog = PathUtils.join(testLogsDir, "ffmpeg", "recent.log");
		const oldLog = PathUtils.join(testLogsDir, "ffmpeg", "old.log");

		await FileUtils.write(recentLog, "recent logs");
		await FileUtils.write(oldLog, "old logs");

		const tenDaysAgo = daysAgo(10);
		await utimes(oldLog, tenDaysAgo, tenDaysAgo);

		const result = await adminLogsService.purgeOldLogs(7);

		expect(result.deletedCount).toBe(1);
		expect(result.retentionDays).toBe(7);
		expect(await FileUtils.exists(recentLog)).toBe(true);
		expect(await FileUtils.exists(oldLog)).toBe(false);
	});
});
