import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";

const root = join(tmpdir(), `reelvault-admin-logs-${randomUUID()}`);
const logsDir = join(root, "logs");
const activeLog = join(logsDir, "reelvault.log");

mockModuleWithRealExports("@/config/server/server.config", {
	serverConfig: {
		...serverConfig,
		paths: { ...serverConfig.paths, logs: logsDir, logFile: activeLog },
	},
});
mockModuleWithRealExports("@/config/system-resources.service", {
	systemResourcesService: { getIoConcurrency: () => 1 },
});
mockModuleWithRealExports("@/services/admin/admin-audit.service", { recordAuditSafe: () => undefined });

const { deleteLogFile, getLogFileDownloadContent, listLogFiles, resolveLogFilePath } = await import("./files.service");
const { serverConfig: mockedServerConfig } = await import("@/config/server/server.config");

async function createLogs(): Promise<void> {
	await rm(logsDir, { recursive: true, force: true });
	await mkdir(join(logsDir, "archive"), { recursive: true });
	await mkdir(join(logsDir, "solo"), { recursive: true });
	await mkdir(join(logsDir, "ffmpeg"), { recursive: true });
	await writeFile(activeLog, "active log");
	await writeFile(join(logsDir, "debug.log"), "debug log");
	await writeFile(join(logsDir, "transcode.log"), "transcode log");
	await writeFile(join(logsDir, "archive", "old.log"), "archived log");
	await writeFile(join(logsDir, "archive", "keep.log"), "keep log");
	await writeFile(join(logsDir, "archive", "reelvault.log"), "nested active name");
	await writeFile(join(logsDir, "solo", "only.log"), "solo log");
	await writeFile(join(logsDir, "ffmpeg", "other.log"), "ffmpeg log");
}

beforeEach(createLogs);

afterAll(async () => {
	restoreModuleMocks();
	await rm(root, { recursive: true, force: true });
});

describe("resolveLogFilePath", () => {
	test("maps a missing id to the active log", () => {
		expect(resolveLogFilePath()).toEqual({ filePath: activeLog, filename: "reelvault.log" });
	});

	test("resolves a top-level and a nested log id inside the logs directory", () => {
		expect(resolveLogFilePath("debug.log")).toEqual({ filePath: join(logsDir, "debug.log"), filename: "debug.log" });
		expect(resolveLogFilePath("archive/old.log")).toEqual({
			filePath: join(logsDir, "archive", "old.log"),
			filename: "old.log",
		});
	});

	test("refuses a log id that starts with parent traversal instead of stripping it", () => {
		expect(() => resolveLogFilePath("../../debug.log")).toThrow(
			expect.objectContaining({ category: "validation", code: "admin.log_path_invalid" }),
		);
	});

	test("rejects a path that escapes the logs directory after the leading segment", () => {
		expect(() => resolveLogFilePath("nested/../../etc/passwd")).toThrow(
			expect.objectContaining({ category: "validation", code: "admin.log_path_invalid" }),
		);
	});

	test("reports the rejected id in the error params", () => {
		expect(() => resolveLogFilePath("")).toThrow(
			expect.objectContaining({ category: "validation", code: "admin.log_path_invalid", params: { fileId: "" } }),
		);
	});

	test.each(["", "   ", "debug.log\0", "."])("rejects an id that names the logs root: %p", (fileId) => {
		expect(() => resolveLogFilePath(fileId)).toThrow(expect.objectContaining({ category: "validation", code: "admin.log_path_invalid" }));
	});
});

describe("getLogFileDownloadContent", () => {
	test("returns the requested log as a streamable file", async () => {
		const download = await getLogFileDownloadContent("archive/old.log");

		expect(download.filename).toBe("old.log");
		expect(await download.file.text()).toBe("archived log");
	});

	test("reports a missing log as not found and keeps the inner reason", async () => {
		await expect(getLogFileDownloadContent("missing.log")).rejects.toMatchObject({
			category: "not_found",
			code: "logs.file_not_found",
			cause: { category: "not_found", code: "admin.log_not_found" },
		});
	});
});

describe("deleteLogFile", () => {
	test("truncates the active log instead of removing it", async () => {
		await expect(deleteLogFile("reelvault.log")).resolves.toEqual({ success: true });

		expect(await Bun.file(activeLog).text()).toBe("");
	});

	test("deletes an archived log and removes its empty parent directory", async () => {
		await expect(deleteLogFile("solo/only.log")).resolves.toEqual({ success: true });

		expect(await Bun.file(join(logsDir, "solo", "only.log")).exists()).toBe(false);
		await expect(stat(join(logsDir, "solo"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("keeps a parent directory that still contains another log", async () => {
		await deleteLogFile("archive/old.log");

		expect(await Bun.file(join(logsDir, "archive", "old.log")).exists()).toBe(false);
		expect((await stat(join(logsDir, "archive"))).isDirectory()).toBe(true);
		expect(await Bun.file(join(logsDir, "archive", "keep.log")).text()).toBe("keep log");
	});

	test("does not truncate a nested file that only shares the active log's basename", async () => {
		await deleteLogFile("archive/reelvault.log");

		expect(await Bun.file(join(logsDir, "archive", "reelvault.log")).exists()).toBe(false);
	});

	test("reports a missing log as not found", async () => {
		await expect(deleteLogFile("missing.log")).rejects.toMatchObject({
			category: "not_found",
			code: "logs.file_not_found",
		});
	});

	test("reports a directory it cannot delete as a delete failure", async () => {
		await expect(deleteLogFile("archive")).rejects.toMatchObject({
			category: "internal",
			code: "logs.delete_failed",
		});
	});
});

describe("listLogFiles", () => {
	test("lists log files with their classified types and sizes", async () => {
		const files = await listLogFiles();
		const byId = new Map(files.map((file) => [file.id, file]));

		expect(byId.get("reelvault.log")).toMatchObject({ type: "server", size: 10 });
		expect(byId.get("debug.log")).toMatchObject({ type: "server" });
		expect(byId.get("transcode.log")).toMatchObject({ type: "ffmpeg-transcode" });
		expect(byId.get("archive/old.log")).toMatchObject({ type: "other", size: 12 });
		expect(byId.get("ffmpeg/other.log")).toMatchObject({ type: "ffmpeg" });
	});

	test("does not duplicate the active log when the directory walk already saw it", async () => {
		const files = await listLogFiles();

		expect(files.filter((file) => file.id === "reelvault.log")).toHaveLength(1);
	});

	test("lists the active log when it lives outside the logs directory", async () => {
		const outsideLog = join(root, "outside.log");
		await writeFile(outsideLog, "outside log");
		const originalLogFile = mockedServerConfig.paths.logFile;
		mockedServerConfig.paths.logFile = outsideLog;
		try {
			const files = await listLogFiles();
			const active = files.find((file) => file.id === "outside.log");

			expect(active).toMatchObject({ type: "server", size: 11 });
		} finally {
			mockedServerConfig.paths.logFile = originalLogFile;
		}
	});
});
