import { afterEach, describe, expect, test } from "bun:test";
import { databaseMaintenanceRepository } from "@/database/repositories/database-maintenance.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { databaseBackupService } from "./database-backup.service";
import { databaseMaintenanceService } from "./database-maintenance.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("databaseMaintenanceService.checkIntegrity", () => {
	test("reports ok only when SQLite answers the single healthy row", async () => {
		stubs.push(stubMethod(databaseMaintenanceRepository, "quickCheck", () => ["ok"]));
		expect(await databaseMaintenanceService.checkIntegrity()).toEqual({ ok: true, messages: ["ok"] });
	});

	test("lists every problem SQLite reports and does not call the database healthy", async () => {
		stubs.push(stubMethod(databaseMaintenanceRepository, "quickCheck", () => ["page 7 is never used", "freelist corrupt"]));
		expect(await databaseMaintenanceService.checkIntegrity()).toEqual({
			ok: false,
			messages: ["page 7 is never used", "freelist corrupt"],
		});
	});
});

describe("databaseBackupService.findBackupFile", () => {
	test("refuses names that could leave the backups folder or are not backups", async () => {
		await expect(databaseBackupService.findBackupFile("../reelvault.sqlite")).rejects.toMatchObject({
			code: "admin.invalid_backup_name",
		});
		await expect(databaseBackupService.findBackupFile("nested/backup.sqlite")).rejects.toMatchObject({
			code: "admin.invalid_backup_name",
		});
		await expect(databaseBackupService.findBackupFile("notes.txt")).rejects.toMatchObject({ code: "admin.invalid_backup_name" });
	});

	test("reports a missing backup as not found", async () => {
		await expect(databaseBackupService.findBackupFile("reelvault_backup_missing.sqlite")).rejects.toMatchObject({
			code: "admin.backup_not_found",
		});
	});
});
