import type { AdminLogFileInfo, AdminLogsPage } from "@reelvault/sdk/common";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { serverConfig } from "@/config/server/server.config";
import { createLogger } from "@/utils/logger.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { getLogBundle } from "./admin-logs/bundle.service";
import { deleteLogFile, getLogFileDownloadContent, listLogFiles } from "./admin-logs/files.service";
import { purgeOldLogs } from "./admin-logs/purge.service";
import { type AdminLogsQuery, getLogs } from "./admin-logs/query.service";
import type { AdminLogsServiceDependencies, AdminLogsState, LogTailEntry } from "./admin-logs/shared.types";

const defaultLogsDependencies: AdminLogsServiceDependencies = {
	logFilePath: serverConfig.paths.logFile,
};

class AdminLogsService {
	readonly serviceName = "AdminLogsService";
	readonly logger = createLogger("AdminLogsService");

	private readonly dependencies: AdminLogsServiceDependencies;

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

	private readonly state: AdminLogsState;

	constructor(dependencies: Partial<AdminLogsServiceDependencies> = {}) {
		this.dependencies = { ...defaultLogsDependencies, ...dependencies };
		this.state = {
			serviceName: this.serviceName,
			logger: this.logger,
			dependencies: this.dependencies,
			logTailCache: this.logTailCache,
		};
	}

	async listLogFiles(): Promise<AdminLogFileInfo[]> {
		return await listLogFiles(this.state);
	}

	/**
	 * Returns a streaming file handle for log downloads instead of buffering the file in memory.
	 */
	async getLogFileDownloadContent(fileId?: string) {
		return await getLogFileDownloadContent(this.state, fileId);
	}

	async deleteLogFile(fileId: string, context?: AdminAuditContext): Promise<{ success: boolean }> {
		return await deleteLogFile(this.state, fileId, context);
	}

	async purgeOldLogs(retentionDays?: number, context?: AdminAuditContext, signal?: AbortSignal, dryRun = false) {
		return await purgeOldLogs(this.state, retentionDays, context, signal, dryRun);
	}

	async getLogs(query?: AdminLogsQuery): Promise<AdminLogsPage> {
		return await getLogs(this.state, query);
	}

	/**
	 * Every log file (current, rotated and the debug log) in one zip for support
	 * requests. Admin-triggered and rate-limited; reads are bounded by the log
	 * directory's retention.
	 */
	async getLogBundle(signal?: AbortSignal) {
		return await getLogBundle(
			signal,
			(...args) => this.listLogFiles(...args),
			(...args) => this.getLogFileDownloadContent(...args),
		);
	}
}

export const adminLogsService = new AdminLogsService();
