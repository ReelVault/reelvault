import { readdir, rename, stat } from "node:fs/promises";
import type { AdminDatabaseBackup } from "@reelvault/sdk/common";
import { file } from "bun";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { DirUtils } from "@/utils/directory.utils";
import { DomainError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute";

/** The first 16 bytes of every SQLite 3 database file. */
const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");

function backupTimestamp(now: Date): string {
	return now
		.toISOString()
		.replace(/[T:.]/g, (ch) => (ch === "T" ? "_" : "-"))
		.replace("Z", "");
}

class DatabaseBackupService {
	readonly serviceName = "DatabaseBackupService";
	readonly logger = createLogger("DatabaseBackupService");

	async createBackup(): Promise<AdminDatabaseBackup> {
		return await runSafely(this, "createBackup", async () => {
			await DirUtils.create(serverConfig.paths.backups);

			const now = new Date();
			const fileName = `reelvault_backup_${backupTimestamp(now)}.sqlite`;
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
		return await runSafely(this, "listBackups", async () => {
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

	/**
	 * Stores an uploaded SQLite backup after checking that it is a ReelVault database SQLite reads without errors. Refused
	 * unless uploads are turned on. The file is staged under a dot name, so listings and rotation never see it before it passes.
	 */
	async uploadBackup(upload: File): Promise<AdminDatabaseBackup> {
		return await runSafely(this, "uploadBackup", async () => {
			if (!systemSettingsStore.get("system.database.backupUploadEnabled")) {
				throw new DomainError("forbidden", "Backup upload is turned off", { code: "database.backup_upload_disabled" });
			}

			const header = new Uint8Array(await upload.slice(0, SQLITE_HEADER.length).arrayBuffer());
			if (header.length !== SQLITE_HEADER.length || !header.every((byte, index) => byte === SQLITE_HEADER[index])) {
				throw new DomainError("validation", "Uploaded file is not a SQLite database", { code: "database.backup_invalid" });
			}

			await DirUtils.create(serverConfig.paths.backups);
			const stagingPath = PathUtils.join(serverConfig.paths.backups, `.upload-${crypto.randomUUID()}.tmp`);
			try {
				await Bun.write(stagingPath, upload);
				if (!databaseMaintenanceRepository.verifyBackupFile(stagingPath)) {
					throw new DomainError("validation", "Uploaded database failed the SQLite check", { code: "database.backup_invalid" });
				}

				const now = new Date();
				const fileName = `reelvault_backup_upload_${backupTimestamp(now)}.sqlite`;
				const filePath = PathUtils.join(serverConfig.paths.backups, fileName);
				await rename(stagingPath, filePath);
				const stats = await stat(filePath);
				this.logger.info("Database backup uploaded", { fileName, sizeBytes: stats.size });

				return { fileName, filePath, sizeBytes: stats.size, createdAt: now.toISOString() };
			} catch (error) {
				await FileUtils.delete(stagingPath);
				throw error;
			}
		});
	}

	/** The backup file behind a download link. Names that could leave the backups folder are refused. */
	async findBackupFile(fileName: string): Promise<{ fileName: string; path: string; sizeBytes: number }> {
		return await runSafely(this, "findBackupFile", async () => {
			if (!fileName.endsWith(".sqlite") || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
				throw new DomainError("validation", "Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			const fullPath = PathUtils.join(serverConfig.paths.backups, fileName);
			if (!PathUtils.isSubpath(fullPath, serverConfig.paths.backups)) {
				throw new DomainError("validation", "Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			const handle = file(fullPath);
			if (!(await handle.exists())) {
				throw new DomainError("not_found", "Backup not found", { code: "admin.backup_not_found", params: { fileName } });
			}

			return { fileName, path: fullPath, sizeBytes: handle.size };
		});
	}

	async deleteBackup(fileName: string): Promise<boolean> {
		return await runSafely(this, "deleteBackup", async () => {
			// Prevent path traversal
			if (fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
				throw new DomainError("validation", "Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			const fullPath = PathUtils.join(serverConfig.paths.backups, fileName);
			if (!PathUtils.isSubpath(fullPath, serverConfig.paths.backups)) {
				throw new DomainError("validation", "Invalid backup file name", { code: "admin.invalid_backup_name" });
			}

			return await FileUtils.delete(fullPath);
		});
	}

	private async rotateBackups(): Promise<void> {
		return await runSafely(this, "rotateBackups", async () => {
			const backups = await this.listBackups();
			const maxRetainedBackups = serverConfig.database.backupRetentionCount;
			if (backups.length > maxRetainedBackups) {
				const toDelete = backups.slice(maxRetainedBackups);
				await PromiseUtils.mapConcurrent(toDelete, systemResourcesService.getIoConcurrency(), (backup) => {
					this.logger.info("Removing old database backup", { fileName: backup.fileName });

					return FileUtils.delete(backup.filePath);
				});
			}
		});
	}
}

export const databaseBackupService = new DatabaseBackupService();
