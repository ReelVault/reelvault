import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { databaseBackupService } from "./database-backup.service";

describe("DatabaseBackupService", () => {
	it("creates a backup that opens as a sound SQLite file of the reported size, and lists it", async () => {
		const backup = await databaseBackupService.createBackup();
		const backupPath = join(serverConfig.paths.backups, backup.fileName);

		try {
			expect(backup.fileName).toContain(".sqlite");
			expect(backup.sizeBytes).toBe((await stat(backupPath)).size);
			const snapshot = new Database(backupPath, { readonly: true });
			try {
				expect(snapshot.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
			} finally {
				snapshot.close();
			}
			expect((await databaseBackupService.listBackups()).some((item) => item.fileName === backup.fileName)).toBe(true);
		} finally {
			// A failed assertion must not leave the backup behind in the shared backups folder.
			await databaseBackupService.deleteBackup(backup.fileName);
		}
	});
});
