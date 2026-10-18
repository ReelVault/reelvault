import { afterEach, describe, expect, test } from "bun:test";
import { databaseMaintenanceRepository } from "@/app/repositories/database-maintenance.repository";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { databaseBackupService } from "./database-backup.service";
import { databaseMaintenanceService } from "./database-maintenance.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("databaseMaintenanceService.checkIntegrity", () => {
	test("reports ok when the real quick check answers with the single healthy row", async () => {
		expect(await databaseMaintenanceService.checkIntegrity()).toEqual({ ok: true, messages: ["ok"] });
	});

	test("lists every problem SQLite reports and does not call the database healthy", async () => {
		// A live database cannot be corrupted on purpose, so the quick check output is stubbed here.
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
});
