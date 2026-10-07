import { readdir, rmdir, stat, truncate, unlink } from "node:fs/promises";
import type { AdminLogEntry, AdminLogFileInfo, AdminLogsPage } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { serverConfig } from "@/server.config";
import { DAY } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { InternalError, NotFoundError, ValidationError } from "@/utils/errors";
import { readFile, safeParseJson } from "@/utils/file.utils";
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

/** Ordered log-type markers — the first match wins, so "transcode" must be
 * tested before the generic "ffmpeg" marker. */
const LOG_TYPE_RULES: ReadonlyArray<readonly [marker: string, type: AdminLogFileInfo["type"], alsoCheckPath?: boolean]> = [
	["transcode", "ffmpeg-transcode"],
	["directstream", "ffmpeg-directstream"],
	["ffmpeg", "ffmpeg", true],
	["reelvault", "server"],
	["debug", "server"],
	["server", "server"],
];

function classifyLogType(name: string, relPath: string): AdminLogFileInfo["type"] {
	const lowerName = normalizeLower(name);
	const lowerRelPath = normalizeLower(relPath);
	for (const [marker, type, alsoCheckPath] of LOG_TYPE_RULES) {
		if (lowerName.includes(marker) || (alsoCheckPath && lowerRelPath.includes(marker))) return type;
	}

	return "other";
}

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

function jsonLogLineMatches(obj: Record<string, unknown>, lineLower: string, filter: LogWindowFilter): boolean {
	return passesLogFilters(resolveJsonLogLevelName(obj), lineLower, filter);
}

function buildJsonLogEntry(obj: Record<string, unknown>): AdminLogEntry {
	const levelName = resolveJsonLogLevelName(obj);
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

function plainLogLineMatches(line: string, lineLower: string, filter: LogWindowFilter): boolean {
	return passesLogFilters(classifyPlainLogLevel(line, lineLower), lineLower, filter);
}

function buildPlainLogEntry(line: string, lineLower: string): AdminLogEntry {
	return { msg: line, levelName: classifyPlainLogLevel(line, lineLower), timestamp: new Date().toISOString() };
}

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const LOG_MAX_PARSED_LINES = 10_000;
/** Appends beyond this many cached lines force a rebuild from the tail window. */
const LOG_TAIL_LINE_CAP = 40_000;

interface LogTailEntry {
	lines: string[];
	parsed: Array<Record<string, unknown> | null>;
	lowerLines: string[];
	/** File size the cache has consumed so far — appends past it are read incrementally. */
	readOffset: number;
	carry: string;
}

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
						const type = classifyLogType(name, relPath);

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
			throw new ValidationError("Invalid log file path", { code: "admin.log_path_invalid", params: { fileId } });
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

	/**
	 * Log viewers poll every few seconds while the logger itself keeps appending
	 * to the same file, so a stat-keyed cache invalidates on every request.
	 * The tail is therefore tracked incrementally: only bytes appended since the
	 * last read are parsed, and the entry rebuilds from the 2 MiB window when it
	 * expires, rotates (file shrank) or grows past the line cap. The TTL only
	 * bounds memory staleness — new bytes are always read incrementally — so it
	 * is sized to cover a viewer that polls slower than its refresh interval
	 * without forcing a full 2 MiB re-parse (30 s).
	 */
	private readonly logTailCache = new MemoryCache<LogTailEntry>({
		ttlMs: 30_000,
		maxSize: 4,
		name: "admin.logTail",
	});

	private async readLogTailLines(fileId?: string): Promise<LogTailEntry> {
		const { filePath } = this.resolveLogFilePath(fileId);
		try {
			const stats = await stat(filePath);
			const cached = this.logTailCache.get(filePath);

			if (cached && stats.size >= cached.readOffset && cached.lines.length < LOG_TAIL_LINE_CAP) {
				if (stats.size > cached.readOffset) {
					const appended = await bunFile(filePath).slice(cached.readOffset, stats.size).text();
					this.appendTailLines(cached, appended);
					cached.readOffset = stats.size;
					this.logTailCache.set(filePath, cached);
				}

				return cached;
			}

			// The size/cap check above established the cached entry is unusable
			// (rotated, truncated or past the line cap). Drop it so getOrSet
			// rebuilds instead of returning the stale entry for the rest of its TTL.
			this.logTailCache.delete(filePath);

			return await this.logTailCache.getOrSet(filePath, () => this.readLogTailWindow(fileId));
		} catch (error) {
			if (error instanceof NotFoundError) throw error;

			this.logger.error("Failed to read log file tail", error, { fileId, filePath });
			throw new InternalError(`Log file could not be read: ${fileId ?? filePath}`, { cause: error });
		}
	}

	private async readLogTailWindow(fileId?: string): Promise<LogTailEntry> {
		const { filePath } = this.resolveLogFilePath(fileId);
		const { content, truncated } = await this.readLogTail(fileId);
		const lines = content.split("\n");
		// When reading a byte-slice tail, the first line may be cut mid-write — skip it.
		if (truncated && lines.length > 0) lines.shift();

		const entry: LogTailEntry = {
			lines: [],
			parsed: [],
			lowerLines: [],
			// The window ends at the CURRENT size — otherwise the next read would
			// treat the whole pre-window file as "appended" and re-read it.
			readOffset: (await stat(filePath)).size,
			carry: "",
		};
		this.appendTailLines(entry, lines.join("\n"));
		entry.carry = "";

		return entry;
	}

	/** Splits appended text into complete lines, carrying a trailing partial line over. */
	private appendTailLines(entry: LogTailEntry, appended: string): void {
		const incoming = (entry.carry + appended).split("\n");
		entry.carry = incoming.pop() ?? "";
		for (const line of incoming) {
			if (!isNonEmptyString(line)) continue;
			const value = safeParseJson(line);
			entry.lines.push(line);
			entry.parsed.push(isRecord(value) ? value : null);
			entry.lowerLines.push(normalizeLower(line));
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
	async deleteLogFile(fileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
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
		} catch (error) {
			this.logger.error("Failed to delete log file", error, { fileId, filePath });
			throw new InternalError(`Log file could not be deleted: ${fileId}`, { cause: error });
		}

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "log_file",
				resourceId: fileId,
				before: { filename, filePath },
				context,
			},
			this.logger,
		);

		return { success: true };
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
							context,
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
		const { lines, parsed, lowerLines } = await this.readLogTailLines(query?.fileId);
		const maxLines = Math.min(lines.length, LOG_MAX_PARSED_LINES);
		const parsedEntries: AdminLogEntry[] = [];

		const searchLower = query?.search ? normalizeLower(query.search) : undefined;
		const targetLevels = query?.level && query.level !== "all" ? new Set(query.level.split(",").map((l) => normalizeLower(l))) : undefined;
		const hasErrorsFilter = targetLevels?.has("errors") ?? false;

		const { page, limit } = QueryPagination.resolvePageParams(query ?? {}, { defaultLimit: 100 });
		const windowStart = (page - 1) * limit;
		const windowEnd = windowStart + limit;
		let totalMatching = 0;

		const filter: LogWindowFilter = { targetLevels, hasErrorsFilter, searchLower, windowStart, windowEnd };

		for (let i = lines.length - 1; i >= 0 && lines.length - i <= maxLines; i--) {
			const line = lines[i];
			if (!line) continue;

			const obj = parsed[i];
			const lineLower = lowerLines[i] ?? "";
			const matches = obj ? jsonLogLineMatches(obj, lineLower, filter) : plainLogLineMatches(line, lineLower, filter);
			if (!matches) continue;

			// Entries outside the pagination window are counted, never materialized —
			// a broad search can match thousands of lines while the page holds a few.
			if (totalMatching >= windowStart && totalMatching < windowEnd) {
				parsedEntries.push(obj ? buildJsonLogEntry(obj) : buildPlainLogEntry(line, lineLower));
			}

			totalMatching++;
		}

		return {
			...QueryPagination.buildAdminPagination({ total: totalMatching, page, limit }),
			data: parsedEntries,
		};
	}
}

export const adminLogsService = new AdminLogsService();
