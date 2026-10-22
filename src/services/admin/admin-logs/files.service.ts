import { readdir, rmdir, truncate } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { AdminLogFileInfo } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import { walkLogFiles } from "@/services/admin/admin-logs/log-walker.utils";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { DomainError, isMissingFile } from "@/utils/domain.errors";
import { normalizePath, resolveWithin } from "@/utils/path.utils";
import { normalizeLower } from "@/utils/type.utils";
import { adminLogsLog } from "./admin-logs.logger";

const leadingParentTraversalPattern = /^(\.\.(\/|\\|$))+/;

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

export async function listLogFiles(): Promise<AdminLogFileInfo[]> {
	const logsDir = serverConfig.paths.logs;
	const results: AdminLogFileInfo[] = [];
	const seenNames = new Set<string>();
	await walkLogFiles(logsDir, {
		logger: adminLogsLog.logger,
		concurrency: systemResourcesService.getIoConcurrency(),
		onFile: (fullPath, stats) => {
			const relPath = relative(logsDir, fullPath);
			const name = basename(fullPath);
			const type = classifyLogType(name, relPath);

			results.push({
				id: relPath,
				name: relPath,
				type,
				size: stats.size,
				modifiedAt: stats.mtime.toISOString(),
			});
			seenNames.add(relPath);
		},
	});

	if (serverConfig.paths.logFile) {
		const mainName = basename(serverConfig.paths.logFile);
		if (!seenNames.has(mainName)) {
			try {
				const stats = await bunFile(serverConfig.paths.logFile).stat();
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

/** The file a log id names, confined to the logs directory. A missing id is the active log. */
export function resolveLogFilePath(fileId?: string): { filePath: string; filename: string } {
	const logsRoot = resolve(serverConfig.paths.logs);
	// Only a missing id means the active log. A blank id ("" or whitespace) names no file and must not
	// fall through to the active log, which deleting would truncate.
	if (fileId === undefined) {
		return { filePath: serverConfig.paths.logFile, filename: basename(serverConfig.paths.logFile) };
	}

	// A NUL byte never belongs in a path, and the logs root itself is a directory, not a log file.
	const trimmed = fileId.trim();
	const cleanId = trimmed.includes("\0") ? "" : normalizePath(trimmed).replace(leadingParentTraversalPattern, "");
	const targetPath = resolveWithin(logsRoot, cleanId);
	if (!targetPath || targetPath === logsRoot) {
		throw new DomainError("validation", "Invalid log file path", { code: "admin.log_path_invalid", params: { fileId } });
	}

	return { filePath: targetPath, filename: basename(targetPath) };
}

/**
 * Returns a streaming file handle for log downloads instead of buffering the file in memory.
 */
export async function getLogFileDownloadContent(fileId?: string): Promise<{ file: ReturnType<typeof bunFile>; filename: string }> {
	const { filePath, filename } = resolveLogFilePath(fileId);
	try {
		const file = bunFile(filePath);
		if (!(await file.exists())) throw new DomainError("not_found", "Log file does not exist", { code: "admin.log_not_found" });

		return { file, filename };
	} catch (error) {
		throw new DomainError("not_found", `Log file not found: ${fileId ?? filename}`, { cause: error, code: "logs.file_not_found" });
	}
}

/** Removes the directory a deleted log file lived in, once it holds no file left. */
async function removeEmptyParentDir(filePath: string): Promise<void> {
	try {
		const parentDir = dirname(filePath);
		if (parentDir === serverConfig.paths.logs) return;

		const remaining = await readdir(parentDir);
		if (remaining.length === 0) {
			await rmdir(parentDir);
		}
	} catch {
		// intentionally empty
	}
}

export async function deleteLogFile(fileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
	const { filePath, filename } = resolveLogFilePath(fileId);
	try {
		if (filename === "reelvault.log" && filePath === serverConfig.paths.logFile) {
			await truncate(filePath, 0);
		} else {
			await bunFile(filePath).delete();
			await removeEmptyParentDir(filePath);
		}
	} catch (error) {
		if (isMissingFile(error))
			throw new DomainError("not_found", `Log file not found: ${fileId}`, { cause: error, code: "logs.file_not_found" });
		adminLogsLog.logger.error("Failed to delete log file", error, { fileId, filePath });
		throw new DomainError("internal", `Log file could not be deleted: ${fileId}`, { cause: error, code: "logs.delete_failed" });
	}

	recordAuditSafe(
		{
			action: "delete",
			resourceType: "log_file",
			resourceId: fileId,
			before: { filename, filePath },
			context,
		},
		adminLogsLog.logger,
	);

	return { success: true };
}
