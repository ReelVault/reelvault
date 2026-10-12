import { join } from "node:path";
import type { AdminDatabaseRestoreResponse } from "@reelvault/sdk/common";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { detachedSpawn } from "@/application/updates/update-install.service";
import { databaseFactory } from "@/database/database";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { runSafely } from "@/utils/safe-execute";

/**
 * Restore replaces the live SQLite file, so it always goes through a server
 * restart: a detached helper waits for this process to exit, swaps the database
 * (removing WAL/SHM sidecars) and relaunches via the platform restart path.
 *
 * Two guards come first. The chosen backup is copied out of the backups folder,
 * so rotation cannot delete it mid-restore, and the current database is backed
 * up, so the state being replaced can be recovered. A restore is refused while
 * streams play, because the restart stops them, unless the caller forces it.
 */
export class DatabaseRestoreService {
	readonly serviceName = "DatabaseRestoreService";
	readonly logger = createLogger("DatabaseRestoreService");

	private readonly countActiveStreams: () => number;

	constructor(countActiveStreams: () => number = () => streamingManager.getAllActiveSessions().length) {
		this.countActiveStreams = countActiveStreams;
	}

	async restore(
		fileName: string,
		rootDir: string,
		dbFileName: string,
		cwd: string,
		options: { force?: boolean | undefined } = {},
	): Promise<AdminDatabaseRestoreResponse> {
		return await runSafely(this, "restore", async () => {
			const backups = await databaseBackupService.listBackups();
			const backup = backups.find((item) => item.fileName === fileName);
			if (!backup) throw new DomainError("not_found", "Database backup not found", { code: "database.backup_not_found" });

			const activeStreams = this.countActiveStreams();
			if (activeStreams > 0 && options.force !== true) {
				throw new DomainError("conflict", "Restore is blocked while streams are active", {
					code: "database.restore_blocked_active_streams",
					params: { activeStreams },
				});
			}

			const dbPath = join(rootDir, dbFileName);
			const stagedPath = `${dbPath}.restore`;
			await Bun.write(stagedPath, Bun.file(backup.filePath));

			let preRestore: { fileName: string };
			try {
				preRestore = await databaseBackupService.createBackup();
			} catch (error) {
				await Bun.file(stagedPath)
					.delete()
					.catch(() => {
						// Best-effort cleanup: the restore is abandoned either way.
					});

				throw error;
			}

			const helperScript = [
				'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done',
				'cp "$2" "$3"',
				'rm -f "$2" "$3-wal" "$3-shm"',
				'cd "$4" && exec ./start.sh',
			].join("; ");

			detachedSpawn("sh", ["-c", helperScript, "sh", String(process.pid), stagedPath, dbPath, cwd]);

			this.logger.warn("Database restore scheduled — the server will restart", {
				from: backup.filePath,
				to: dbPath,
				preRestoreBackup: preRestore.fileName,
			});
			databaseFactory.shutdown();

			return { success: true, restarting: true, restoredFrom: backup.fileName, preRestoreBackup: preRestore.fileName };
		});
	}
}

export const databaseRestoreService = new DatabaseRestoreService();
