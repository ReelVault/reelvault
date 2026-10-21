import { describe, expect, it } from "bun:test";
import { databaseBackupService } from "./database-backup.service";

describe("DatabaseBackupService", () => {
	it("creates a backup and lists it", async () => {
		const backup = await databaseBackupService.createBackup();

		try {
			expect(backup.fileName).toContain(".sqlite");
			expect(backup.sizeBytes).toBeGreaterThan(0);
			expect((await databaseBackupService.listBackups()).some((item) => item.fileName === backup.fileName)).toBe(true);
		} finally {
			// A failed assertion must not leave the backup behind in the shared backups folder.
			await databaseBackupService.deleteBackup(backup.fileName);
		}
	});
});
