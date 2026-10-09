import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemSettingsStore } from "@/config/system-settings.store";
import { serverConfig } from "@/server.config";
import { databaseBackupService } from "./database-backup.service";

const UPLOAD_SETTING = "system.database.backupUploadEnabled";
const uploadedFileNames: string[] = [];
let fixtureDir: string;

beforeEach(async () => {
	fixtureDir = await mkdtemp(join(tmpdir(), "reelvault-backup-upload-test-"));
});

afterEach(async () => {
	systemSettingsStore.setRuntimeValue(UPLOAD_SETTING, false);
	for (const fileName of uploadedFileNames.splice(0)) await databaseBackupService.deleteBackup(fileName);
	await rm(fixtureDir, { recursive: true, force: true });
});

/** Writes a small SQLite database with the given tables and returns it as an upload. */
async function sqliteUpload(tables: string[]): Promise<File> {
	const path = join(fixtureDir, "source.db");
	const db = new Database(path);
	for (const table of tables) db.run(`CREATE TABLE ${table} (id INTEGER)`);
	db.close();

	return new File([await Bun.file(path).arrayBuffer()], "server.sqlite");
}

async function stagingFilesLeft(): Promise<string[]> {
	return (await readdir(serverConfig.paths.backups)).filter((name) => name.startsWith(".upload-"));
}

describe("DatabaseBackupService.uploadBackup", () => {
	it("stores a ReelVault database under the upload name and leaves no staging file", async () => {
		systemSettingsStore.setRuntimeValue(UPLOAD_SETTING, true);
		const upload = await sqliteUpload(["__drizzle_migrations"]);

		const backup = await databaseBackupService.uploadBackup(upload);
		uploadedFileNames.push(backup.fileName);

		expect(backup.fileName.startsWith("reelvault_backup_upload_")).toBe(true);
		expect(backup.sizeBytes).toBe(upload.size);
		expect((await databaseBackupService.listBackups()).map((item) => item.fileName)).toContain(backup.fileName);
		expect(await stagingFilesLeft()).toEqual([]);
	});

	it("refuses uploads while the setting is off", async () => {
		systemSettingsStore.setRuntimeValue(UPLOAD_SETTING, false);
		const upload = await sqliteUpload(["__drizzle_migrations"]);

		await expect(databaseBackupService.uploadBackup(upload)).rejects.toMatchObject({ code: "database.backup_upload_disabled" });
		expect((await databaseBackupService.listBackups()).some((item) => item.fileName.includes("_upload_"))).toBe(false);
	});

	it("refuses a file that does not start with the SQLite header", async () => {
		systemSettingsStore.setRuntimeValue(UPLOAD_SETTING, true);
		const upload = new File(["not a database at all"], "server.sqlite");

		await expect(databaseBackupService.uploadBackup(upload)).rejects.toMatchObject({ code: "database.backup_invalid" });
		expect(await stagingFilesLeft()).toEqual([]);
	});

	it("refuses a SQLite file without the migration journal and leaves nothing behind", async () => {
		systemSettingsStore.setRuntimeValue(UPLOAD_SETTING, true);
		const upload = await sqliteUpload(["metadata"]);

		await expect(databaseBackupService.uploadBackup(upload)).rejects.toMatchObject({ code: "database.backup_invalid" });
		expect(await stagingFilesLeft()).toEqual([]);
		expect((await databaseBackupService.listBackups()).some((item) => item.fileName.includes("_upload_"))).toBe(false);
	});
});
