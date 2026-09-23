import { readdir, stat } from "node:fs/promises";
import type { AdminDatabaseBackup } from "@reelvault/sdk/common";
import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

const MAX_RETAINED_BACKUPS = 7;

class DatabaseBackupService extends BaseService {
	constructor() {
		super("DatabaseBackupService");
	}

	async createBackup(): Promise<AdminDatabaseBackup> {
		return await this.safeExecute("createBackup", async () => {
			await DirUtils.create(serverConfig.paths.backups);

			const now = new Date();
			const timestamp = now
				.toISOString()
				.replace(/[T:.]/g, (ch) => (ch === "T" ? "_" : "-"))
				.replace("Z", "");
			const fileName = `reelvault_backup_${timestamp}.sqlite`;
			const filePath = PathUtils.join(serverConfig.paths.backups, fileName);

			this.logger.info("Starting SQLite database backup", { targetPath: filePath });
			await databaseMaintenanceRepository.backup(filePath);

			const stats = await stat(filePath);
			const backup: AdminDatabaseBackup = {
				fileName,
				filePath,
				sizeBytes: stats.size,
				createdAt: now.toISOString(),
			};

			this.logger.info("Database backup created successfully", { fileName, sizeBytes: stats.size });

			// Rotate old backups
			await this.rotateBackups();

			return backup;
		});
	}

	async listBackups(): Promise<AdminDatabaseBackup[]> {
		return await this.safeExecute("listBackups", async () => {
			await DirUtils.create(serverConfig.paths.backups);
			const entries = await readdir(serverConfig.paths.backups, { withFileTypes: true });
			const sqliteEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"));
			const backups = await PromiseUtils.mapConcurrent(sqliteEntries, systemResourcesService.getIoConcurrency(), async (entry) => {
				const fullPath = PathUtils.join(serverConfig.paths.backups, entry.name);
				const stats = await stat(fullPath);

				return {
					fileName: entry.name,
					filePath: fullPath,
					sizeBytes: stats.size,
					createdAt: stats.mtime.toISOString(),
					mtimeMs: stats.mtimeMs,
				};
			});

			return backups.toSorted((a, b) => b.mtimeMs - a.mtimeMs).map(({ mtimeMs: _mtimeMs, ...backup }) => backup);
		});
	}

	async deleteBackup(fileName: string): Promise<boolean> {
		return await this.safeExecute("deleteBackup", async () => {
			// Prevent path traversal
			if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
				throw new ValidationError("Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			const fullPath = PathUtils.join(serverConfig.paths.backups, fileName);
			if (!PathUtils.isSubpath(fullPath, serverConfig.paths.backups)) {
				throw new ValidationError("Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			return await FileUtils.delete(fullPath);
		});
	}

	private async rotateBackups(): Promise<void> {
		return await this.safeExecute("rotateBackups", async () => {
			const backups = await this.listBackups();
			if (backups.length > MAX_RETAINED_BACKUPS) {
				const toDelete = backups.slice(MAX_RETAINED_BACKUPS);
				await PromiseUtils.mapConcurrent(toDelete, systemResourcesService.getIoConcurrency(), (backup) => {
					this.logger.info("Removing old database backup", { fileName: backup.fileName });

					return FileUtils.delete(backup.filePath);
				});
			}
		});
	}
}

export const databaseBackupService = new DatabaseBackupService();
