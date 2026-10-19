import { readdir, rmdir, truncate } from "node:fs/promises";
import { file as bunFile } from "bun";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { serverConfig } from "@/config/server/server.config";
import { DAY } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { DirUtils } from "@/utils/directory.utils";
import { PathUtils } from "@/utils/path.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import type { AdminLogsState } from "./shared.types";

/** Settings shared by every directory visited during one log purge pass. */
interface LogPurgeScope {
	logsDir: string;
	cutoffMs: number;
	mainLogPath: string | null;
	signal: AbortSignal | undefined;
	dryRun: boolean;
}

/**
 * Deletes log files older than the retention window (the active log is truncated instead of unlinked). A dry run
 * counts what would go without touching anything. Records one audit entry when a real run removed files.
 */
export async function purgeOldLogs(
	state: AdminLogsState,
	retentionDays?: number,
	context?: AdminAuditContext,
	signal?: AbortSignal,
	dryRun = false,
): Promise<{ scannedCount: number; deletedCount: number; freedBytes: number; retentionDays: number }> {
	return await runSafely(
		state,
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

			const mainLogPath = state.dependencies.logFilePath ? PathUtils.resolve(state.dependencies.logFilePath) : null;
			const stats = await cleanLogDirectory(state, logsDir, { logsDir, cutoffMs, mainLogPath, signal, dryRun });

			if (!dryRun && context?.actorUserId && stats.deletedCount > 0) {
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
					state.logger,
				);
			}

			return { scannedCount: stats.scannedCount, deletedCount: stats.deletedCount, freedBytes: stats.freedBytes, retentionDays: days };
		},
		{ errorMessage: "Failed to purge old log files" },
	);
}

/** Removes a purged sub-directory once the last log file in it is gone. */
async function removeEmptyDirectory(fullPath: string, logsDir: string, dryRun: boolean): Promise<void> {
	try {
		if (fullPath === logsDir || dryRun) return;

		const remaining = await readdir(fullPath);
		if (remaining.length === 0) await rmdir(fullPath);
	} catch {
		// intentionally empty
	}
}

async function cleanLogDirectory(
	state: AdminLogsState,
	currentDir: string,
	scope: LogPurgeScope,
): Promise<{ scannedCount: number; deletedCount: number; freedBytes: number }> {
	const { logsDir, cutoffMs, mainLogPath, signal, dryRun } = scope;
	let scannedCount = 0;
	let deletedCount = 0;
	let freedBytes = 0;

	try {
		const entries = await readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			throwIfAborted(signal);
			const fullPath = PathUtils.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				const subResult = await cleanLogDirectory(state, fullPath, scope);
				scannedCount += subResult.scannedCount;
				deletedCount += subResult.deletedCount;
				freedBytes += subResult.freedBytes;

				await removeEmptyDirectory(fullPath, logsDir, dryRun);
			} else if (entry.isFile() && entry.name.endsWith(".log")) {
				scannedCount++;
				const result = await purgeSingleLogFile(state, fullPath, cutoffMs, mainLogPath, dryRun);
				if (result.deleted) {
					deletedCount++;
					freedBytes += result.bytes;
				}
			}
		}
	} catch (error) {
		state.logger.error("Error scanning log directory for purge", { path: currentDir, error: error });
	}

	return { scannedCount, deletedCount, freedBytes };
}

async function purgeSingleLogFile(
	state: AdminLogsState,
	fullPath: string,
	cutoffMs: number,
	mainLogPath: string | null,
	dryRun = false,
): Promise<{ deleted: boolean; bytes: number }> {
	try {
		const stats = await bunFile(fullPath).stat();
		if (stats.mtime.getTime() >= cutoffMs) return { deleted: false, bytes: 0 };
		if (dryRun) return { deleted: true, bytes: stats.size };

		const resolvedPath = PathUtils.resolve(fullPath);
		if (mainLogPath && resolvedPath === mainLogPath) {
			await truncate(resolvedPath, 0);
		} else {
			await bunFile(resolvedPath).delete();
		}

		return { deleted: true, bytes: stats.size };
	} catch (error) {
		state.logger.warn("Failed to purge old log file", { path: fullPath, error: error });

		return { deleted: false, bytes: 0 };
	}
}
