import { join } from "node:path";
import type { AdminDatabaseRestoreResponse } from "@reelvault/sdk/common";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { detachedSpawn } from "@/application/updates/update-install.service";
import { databaseFactory } from "@/database/database";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";

/**
 * Restore replaces the live SQLite file, so it always goes through a server
 * restart: a detached helper waits for this process to exit, swaps the database
 * (removing WAL/SHM sidecars) and relaunches via the platform restart path.
 */
class DatabaseRestoreService extends BaseService {
	constructor() {
		super("DatabaseRestoreService");
	}

	async restore(fileName: string, rootDir: string, dbFileName: string, cwd: string): Promise<AdminDatabaseRestoreResponse> {
		return await this.safeExecute("restore", async () => {
			const backups = await databaseBackupService.listBackups();
			const backup = backups.find((item) => item.fileName === fileName);
			if (!backup) throw new NotFoundError("Database backup not found", { code: "database.backup_not_found" });

			const dbPath = join(rootDir, dbFileName);
			const helperScript = [
				'while kill -0 "$1" 2>/dev/null; do sleep 0.5; done',
				'cp "$2" "$3"',
				'rm -f "$3-wal" "$3-shm"',
				'cd "$4" && exec ./start.sh',
			].join("; ");

			detachedSpawn("sh", ["-c", helperScript, "sh", String(process.pid), backup.filePath, dbPath, cwd]);

			this.logger.warn("Database restore scheduled — the server will restart", { from: backup.filePath, to: dbPath });
			databaseFactory.shutdown();

			return { success: true, restarting: true, restoredFrom: backup.fileName };
		});
	}
}

export const databaseRestoreService = new DatabaseRestoreService();
