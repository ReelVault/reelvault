import { describe, expect, it } from "bun:test";
import { databaseBackupService } from "./database-backup.service";

describe("DatabaseBackupService", () => {
	it("creates a backup and lists backups", async () => {
		const backup = await databaseBackupService.createBackup();

		expect(backup.fileName).toContain(".sqlite");
		expect(backup.sizeBytes).toBeGreaterThan(0);

		const backups = await databaseBackupService.listBackups();
		expect(backups.length).toBeGreaterThanOrEqual(1);
		expect(backups.some((b) => b.fileName === backup.fileName)).toBe(true);

		// Clean up created test backup
		await databaseBackupService.deleteBackup(backup.fileName);
	});
});
