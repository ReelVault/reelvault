import { readdir, rmdir, stat, truncate, unlink } from "node:fs/promises";
import type { AdminLogEntry, AdminLogFileInfo, AdminLogsPage } from "@sdk/common";
import { file as bunFile } from "bun";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { serverConfig } from "@/server.config";
import { DAY } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { fileStatSignature, readFile, safeParseJson } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { isFiniteNumber, isNonEmptyString, isRecord, normalizeLower } from "@/utils/type.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { recordAuditSafe } from "./admin-audit.service";

interface AdminLogsServiceDependencies {
	logFilePath: string;
}

const leadingParentTraversalPattern = /^(\.\.(\/|\\|$))+/;
const ERROR_LEVELS = new Set(["warn", "error", "fatal"]);
const PINO_LEVEL_NAMES: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

function matchesLevelFilter(levelName: string, targetLevels: Set<string> | undefined, hasErrorsFilter: boolean): boolean {
	if (!targetLevels) return true;

	const levelLower = levelName.toLowerCase();

	return targetLevels.has(levelLower) || (hasErrorsFilter && ERROR_LEVELS.has(levelLower));
}

interface LogWindowFilter {
	targetLevels: Set<string> | undefined;
	hasErrorsFilter: boolean;
	searchLower: string | undefined;
	windowStart: number;
	windowEnd: number;
}

function resolveJsonLogLevelName(obj: Record<string, unknown>): string {
	const numericLevel = obj.level;
	if (typeof numericLevel === "number") return PINO_LEVEL_NAMES[numericLevel] ?? "info";

	if (typeof obj.level === "string") return obj.level;

	return "info";
}

function passesLogFilters(levelName: string, lineLower: string, filter: LogWindowFilter): boolean {
	if (!matchesLevelFilter(levelName, filter.targetLevels, filter.hasErrorsFilter)) return false;

	if (filter.searchLower && !lineLower.includes(filter.searchLower)) return false;

	return true;
}

function matchJsonLogLine(line: string, obj: Record<string, unknown>, filter: LogWindowFilter): AdminLogEntry | undefined {
	const levelName = resolveJsonLogLevelName(obj);
	// JSON lines carry their level in `obj.level`; the lowercased copy is only
	// needed for the free-text search, so skip it when there is no search.
	const lineLower = filter.searchLower ? normalizeLower(line) : "";
	if (!passesLogFilters(levelName, lineLower, filter)) return undefined;

	const timeValue = typeof obj.time === "string" || typeof obj.time === "number" ? obj.time : undefined;

	return {
		...obj,
		levelName,
		timestamp: timeValue ? new Date(timeValue).toISOString() : new Date().toISOString(),
	};
}

function classifyPlainLogLevel(line: string, lineLower: string): "debug" | "error" | "info" | "warn" {
	if (lineLower.includes("error") || line.includes("[error]")) return "error";

	if (lineLower.includes("warn") || line.includes("[stderr]")) return "warn";

	if (lineLower.includes("debug") || line.includes("[progress]")) return "debug";

	return "info";
}

function matchPlainLogLine(line: string, filter: LogWindowFilter): AdminLogEntry | undefined {
	const lineLower = normalizeLower(line);
	const levelName = classifyPlainLogLevel(line, lineLower);
	if (!passesLogFilters(levelName, lineLower, filter)) return undefined;

	return { msg: line, levelName, timestamp: new Date().toISOString() };
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_MAX_PARSED_LINES = 10_000;

const defaultLogsDependencies: AdminLogsServiceDependencies = {
	logFilePath: serverConfig.paths.logFile,
};

class AdminLogsService extends BaseService {
	private readonly dependencies: AdminLogsServiceDependencies;

	constructor(dependencies: Partial<AdminLogsServiceDependencies> = {}) {
		super("AdminLogsService");
		this.dependencies = { ...defaultLogsDependencies, ...dependencies };
	}

	async listLogFiles(): Promise<AdminLogFileInfo[]> {
		const logsDir = serverConfig.paths.logs;
		const results: AdminLogFileInfo[] = [];
		const seenNames = new Set<string>();
		const logger = this.logger;

		async function scanDirectory(currentDir: string) {
			try {
				const entries = await readdir(currentDir, { withFileTypes: true });
				await PromiseUtils.mapConcurrent(entries, systemResourcesService.getIoConcurrency(), async (entry) => {
					const fullPath = PathUtils.join(currentDir, entry.name);
					if (entry.isDirectory()) {
						await scanDirectory(fullPath);
					} else if (entry.isFile() && entry.name.endsWith(".log")) {
						const stats = await stat(fullPath);
						const relPath = PathUtils.relative(logsDir, fullPath);
						const name = PathUtils.getFileName(fullPath);
						let type: AdminLogFileInfo["type"] = "other";
						const lowerName = normalizeLower(name);
						const lowerRelPath = normalizeLower(relPath);

						if (lowerName.includes("transcode")) {
							type = "ffmpeg-transcode";
						} else if (lowerName.includes("directstream")) {
							type = "ffmpeg-directstream";
						} else if (lowerName.includes("ffmpeg") || lowerRelPath.includes("ffmpeg")) {
							type = "ffmpeg";
						} else if (lowerName.includes("reelvault") || lowerName.includes("debug") || lowerName.includes("server")) {
							type = "server";
						}

						results.push({
							id: relPath,
							name: relPath,
							type,
							size: stats.size,
							modifiedAt: stats.mtime.toISOString(),
						});
						seenNames.add(relPath);
					}
				});
			} catch (err) {
				logger.error("Error scanning log directory", { path: currentDir, error: err });
			}
		}

		await scanDirectory(logsDir);

		if (this.dependencies.logFilePath) {
			const mainName = PathUtils.getFileName(this.dependencies.logFilePath);
			if (!seenNames.has(mainName)) {
				try {
					const stats = await stat(this.dependencies.logFilePath);
					results.push({
						id: mainName,
						name: mainName,
						type: "server",
						size: stats.size,
						modifiedAt: stats.mtime.toISOString(),
					});
				} catch {
					// intentionally empty
				}
			}
		}

		results.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

		return results;
	}
	private resolveLogFilePath(fileId?: string): { filePath: string; filename: string } {
		const logsRoot = PathUtils.resolve(serverConfig.paths.logs);
		if (!isNonEmptyString(fileId)) {
			return { filePath: this.dependencies.logFilePath, filename: PathUtils.getFileName(this.dependencies.logFilePath) };
		}

		const cleanId = PathUtils.normalize(fileId.trim()).replace(leadingParentTraversalPattern, "");
		const targetPath = PathUtils.resolve(PathUtils.join(logsRoot, cleanId));
		if (!PathUtils.isSubpath(targetPath, logsRoot) && targetPath !== logsRoot) {
			throw new ValidationError("Invalid log file path");
		}

		return { filePath: targetPath, filename: PathUtils.getFileName(targetPath) };
	}

	/**
	 * Reads only the tail of a log file (last ~2 MB) to avoid loading potentially
	 * gigabyte-sized log files fully into memory. Small files are read whole.
	 */
	private async readLogTail(fileId?: string): Promise<{ content: string; truncated: boolean }> {
		const { filePath } = this.resolveLogFilePath(fileId);
		try {
			const fileSize = (await stat(filePath)).size;
			if (fileSize <= LOG_TAIL_BYTES) {
				const content = await readFile(filePath, "utf-8");

				return { content, truncated: false };
			}

			const content = await bunFile(filePath)
				.slice(fileSize - LOG_TAIL_BYTES, fileSize)
				.text();

			return { content, truncated: true };
		} catch {
			throw new NotFoundError(`Log file not found: ${fileId ?? filePath}`);
		}
	}

	/** Log viewers poll every few seconds; re-reading and re-splitting up to
	 * 2 MB per poll is pure waste while the file is unchanged. */
	private readonly logTailCache = new MemoryCache<{ lines: string[] }>({
		ttlMs: 2_000,
		maxSize: 4,
		name: "admin.logTail",
	});

	private async readLogTailLines(fileId?: string): Promise<{ lines: string[] }> {
		const { filePath } = this.resolveLogFilePath(fileId);
		try {
			const stats = await stat(filePath);
			const cacheKey = `${filePath}:${fileStatSignature(stats)}`;

			return await this.logTailCache.getOrSet(cacheKey, async () => {
				const { content, truncated } = await this.readLogTail(fileId);
				let lines = content.split("\n").filter((line) => isNonEmptyString(line));
				// When reading a byte-slice tail, the first line may be cut mid-write — skip it.
				if (truncated && lines.length > 0) lines = lines.slice(1);

				return { lines };
			});
		} catch (error) {
			if (error instanceof NotFoundError) throw error;

			throw new NotFoundError(`Log file not found: ${fileId ?? filePath}`);
		}
	}

	/**
	 * Returns a streaming file handle for log downloads instead of buffering the file in memory.
	 */
	async getLogFileDownloadContent(fileId?: string): Promise<{ file: ReturnType<typeof bunFile>; filename: string }> {
		const { filePath, filename } = this.resolveLogFilePath(fileId);
		try {
			const file = bunFile(filePath);
			if (!(await file.exists())) throw new NotFoundError("Log file does not exist", { code: "admin.log_not_found" });

			return { file, filename };
		} catch {
			throw new NotFoundError(`Log file not found: ${fileId ?? filename}`);
		}
	}
	async deleteLogFile(fileId: string, actorUserId?: string, headers?: Headers): Promise<{ success: boolean }> {
		const { filePath, filename } = this.resolveLogFilePath(fileId);
		try {
			if (filename === "reelvault.log" && filePath === this.dependencies.logFilePath) {
				await truncate(filePath, 0);
			} else {
				await unlink(filePath);
				try {
					const parentDir = PathUtils.getDirName(filePath);
					if (parentDir !== serverConfig.paths.logs) {
						const remaining = await readdir(parentDir);
						if (remaining.length === 0) {
							await rmdir(parentDir);
						}
					}
				} catch {
					// intentionally empty
				}
			}

			recordAuditSafe(
				{
					action: "delete",
					resourceType: "log_file",
					resourceId: fileId,
					before: { filename, filePath },
					context: { actorUserId, headers },
				},
				this.logger,
			);

			return { success: true };
		} catch (error) {
			this.logger.error("Failed to delete log file", { fileId, filePath, error });
			throw new NotFoundError(`Log file could not be deleted: ${fileId}`);
		}
	}
	async purgeOldLogs(
		retentionDays?: number,
		context?: AdminAuditContext,
		signal?: AbortSignal,
	): Promise<{ scannedCount: number; deletedCount: number; freedBytes: number; retentionDays: number }> {
		return await this.safeExecute(
			"purgeOldLogs",
			async () => {
				throwIfAborted(signal);
				const days =
					retentionDays && isFiniteNumber(retentionDays) && retentionDays >= 1
						? Math.floor(retentionDays)
						: serverConfig.paths.logsRetentionDays;

				const cutoffMs = Date.now() - days * DAY;
				const logsDir = serverConfig.paths.logs;

				if (!(await DirUtils.exists(logsDir))) {
					return { scannedCount: 0, deletedCount: 0, freedBytes: 0, retentionDays: days };
				}

				const mainLogPath = this.dependencies.logFilePath ? PathUtils.resolve(this.dependencies.logFilePath) : null;
				const stats = await this.cleanLogDirectory(logsDir, logsDir, cutoffMs, mainLogPath, signal);

				if (context?.actorUserId && stats.deletedCount > 0) {
					recordAuditSafe(
						{
							action: "delete",
							resourceType: "log_files_cleanup",
							resourceId: "system_logs",
							after: {
								scannedCount: stats.scannedCount,
								deletedCount: stats.deletedCount,
								freedBytes: stats.freedBytes,
								retentionDays: days,
							},
							context: { actorUserId: context.actorUserId, headers: context.headers },
						},
						this.logger,
					);
				}

				return { scannedCount: stats.scannedCount, deletedCount: stats.deletedCount, freedBytes: stats.freedBytes, retentionDays: days };
			},
			{ errorMessage: "Failed to purge old log files" },
		);
	}

	private async cleanLogDirectory(
		currentDir: string,
		logsDir: string,
		cutoffMs: number,
		mainLogPath: string | null,
		signal?: AbortSignal,
	): Promise<{ scannedCount: number; deletedCount: number; freedBytes: number }> {
		let scannedCount = 0;
		let deletedCount = 0;
		let freedBytes = 0;

		try {
			const entries = await readdir(currentDir, { withFileTypes: true });
			for (const entry of entries) {
				throwIfAborted(signal);
				const fullPath = PathUtils.join(currentDir, entry.name);

				if (entry.isDirectory()) {
					const subResult = await this.cleanLogDirectory(fullPath, logsDir, cutoffMs, mainLogPath, signal);
					scannedCount += subResult.scannedCount;
					deletedCount += subResult.deletedCount;
					freedBytes += subResult.freedBytes;

					try {
						if (fullPath !== logsDir) {
							const remaining = await readdir(fullPath);
							if (remaining.length === 0) await rmdir(fullPath);
						}
					} catch {
						// intentionally empty
					}
				} else if (entry.isFile() && entry.name.endsWith(".log")) {
					scannedCount++;
					const result = await this.purgeSingleLogFile(fullPath, cutoffMs, mainLogPath);
					if (result.deleted) {
						deletedCount++;
						freedBytes += result.bytes;
					}
				}
			}
		} catch (dirErr) {
			this.logger.error("Error scanning log directory for purge", { path: currentDir, error: dirErr });
		}

		return { scannedCount, deletedCount, freedBytes };
	}

	private async purgeSingleLogFile(
		fullPath: string,
		cutoffMs: number,
		mainLogPath: string | null,
	): Promise<{ deleted: boolean; bytes: number }> {
		try {
			const stats = await stat(fullPath);
			if (stats.mtime.getTime() >= cutoffMs) return { deleted: false, bytes: 0 };

			const resolvedPath = PathUtils.resolve(fullPath);
			if (mainLogPath && resolvedPath === mainLogPath) {
				await truncate(resolvedPath, 0);
			} else {
				await unlink(resolvedPath);
			}

			return { deleted: true, bytes: stats.size };
		} catch (fileErr) {
			this.logger.warn("Failed to purge old log file", { path: fullPath, error: fileErr });

			return { deleted: false, bytes: 0 };
		}
	}

	async getLogs(query?: { fileId?: string; level?: string; search?: string; limit?: number; page?: number }): Promise<AdminLogsPage> {
		try {
			const { lines } = await this.readLogTailLines(query?.fileId);
			const maxLines = Math.min(lines.length, LOG_MAX_PARSED_LINES);
			const parsedEntries: AdminLogEntry[] = [];

			const searchLower = query?.search ? normalizeLower(query.search) : undefined;
			const targetLevels =
				query?.level && query.level !== "all" ? new Set(query.level.split(",").map((l) => normalizeLower(l))) : undefined;
			const hasErrorsFilter = targetLevels?.has("errors") ?? false;

			const limit = Math.max(1, query?.limit ?? 100);
			const page = Math.max(1, query?.page ?? 1);
			const windowStart = (page - 1) * limit;
			const windowEnd = windowStart + limit;
			let totalMatching = 0;

			const filter: LogWindowFilter = { targetLevels, hasErrorsFilter, searchLower, windowStart, windowEnd };

			for (let i = lines.length - 1; i >= 0 && lines.length - i <= maxLines; i--) {
				const line = lines[i];
				if (!line) continue;

				const parsed = safeParseJson(line);
				const obj = isRecord(parsed) ? parsed : null;
				const entry = obj ? matchJsonLogLine(line, obj, filter) : matchPlainLogLine(line, filter);
				if (!entry) continue;

				if (totalMatching >= windowStart && totalMatching < windowEnd) parsedEntries.push(entry);

				totalMatching++;
			}

			const totalPages = Math.ceil(totalMatching / limit) || 1;

			return { data: parsedEntries, pagination: { total: totalMatching, page, limit, totalPages } };
		} catch (error) {
			this.logger.warn("Failed to read log file", { fileId: query?.fileId, error });

			return { data: [], pagination: { total: 0, page: 1, limit: query?.limit ?? 100, totalPages: 0 } };
		}
	}
}

export const adminLogsService = new AdminLogsService();
