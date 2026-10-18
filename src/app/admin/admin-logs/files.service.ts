import { readdir, rmdir, truncate } from "node:fs/promises";
import type { AdminLogFileInfo } from "@reelvault/sdk/common";
import { file as bunFile } from "bun";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { DomainError, isMissingFile } from "@/utils/domain.errors";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { normalizeLower } from "@/utils/type.utils";
import type { AdminLogsState } from "./shared.types";

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

export async function listLogFiles(state: AdminLogsState): Promise<AdminLogFileInfo[]> {
	const logsDir = serverConfig.paths.logs;
	const results: AdminLogFileInfo[] = [];
	const seenNames = new Set<string>();
	const logger = state.logger;

	async function scanDirectory(currentDir: string) {
		try {
			const entries = await readdir(currentDir, { withFileTypes: true });
			await PromiseUtils.mapConcurrent(entries, systemResourcesService.getIoConcurrency(), async (entry) => {
				const fullPath = PathUtils.join(currentDir, entry.name);
				if (entry.isDirectory()) {
					await scanDirectory(fullPath);
				} else if (entry.isFile() && entry.name.endsWith(".log")) {
					const stats = await bunFile(fullPath).stat();
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

	if (state.dependencies.logFilePath) {
		const mainName = PathUtils.getFileName(state.dependencies.logFilePath);
		if (!seenNames.has(mainName)) {
			try {
				const stats = await bunFile(state.dependencies.logFilePath).stat();
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
export function resolveLogFilePath(state: AdminLogsState, fileId?: string): { filePath: string; filename: string } {
	const logsRoot = PathUtils.resolve(serverConfig.paths.logs);
	// Only a missing id means the active log. A blank id ("" or whitespace) names no file and must not
	// fall through to the active log, which deleting would truncate.
	if (fileId === undefined) {
		return { filePath: state.dependencies.logFilePath, filename: PathUtils.getFileName(state.dependencies.logFilePath) };
	}

	// A NUL byte never belongs in a path, and the logs root itself is a directory, not a log file.
	const trimmed = fileId.trim();
	const cleanId = trimmed.includes("\0") ? "" : PathUtils.normalize(trimmed).replace(leadingParentTraversalPattern, "");
	const targetPath = PathUtils.resolve(PathUtils.join(logsRoot, cleanId));
	if (targetPath === logsRoot || !PathUtils.isSubpath(targetPath, logsRoot)) {
		throw new DomainError("validation", "Invalid log file path", { code: "admin.log_path_invalid", params: { fileId } });
	}

	return { filePath: targetPath, filename: PathUtils.getFileName(targetPath) };
}

/**
 * Returns a streaming file handle for log downloads instead of buffering the file in memory.
 */
export async function getLogFileDownloadContent(
	state: AdminLogsState,
	fileId?: string,
): Promise<{ file: ReturnType<typeof bunFile>; filename: string }> {
	const { filePath, filename } = resolveLogFilePath(state, fileId);
	try {
		const file = bunFile(filePath);
		if (!(await file.exists())) throw new DomainError("not_found", "Log file does not exist", { code: "admin.log_not_found" });

		return { file, filename };
	} catch {
		throw new DomainError("not_found", `Log file not found: ${fileId ?? filename}`, { code: "logs.file_not_found" });
	}
}

export async function deleteLogFile(state: AdminLogsState, fileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
	const { filePath, filename } = resolveLogFilePath(state, fileId);
	try {
		if (filename === "reelvault.log" && filePath === state.dependencies.logFilePath) {
			await truncate(filePath, 0);
		} else {
			await bunFile(filePath).delete();
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
		if (isMissingFile(error)) throw new DomainError("not_found", `Log file not found: ${fileId}`, { code: "logs.file_not_found" });
		state.logger.error("Failed to delete log file", error, { fileId, filePath });
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
		state.logger,
	);

	return { success: true };
}
