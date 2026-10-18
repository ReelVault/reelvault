import { afterEach, describe, expect, test } from "bun:test";
import { databaseBackupService } from "@/app/admin/database-backup.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { DatabaseRestoreService } from "./database-restore.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

const BACKUP = { fileName: "nightly.sqlite", filePath: "/backups/nightly.sqlite", sizeBytes: 1024, createdAt: "2026-10-09T10:00:00.000Z" };

describe("DatabaseRestoreService.restore", () => {
	test("refuses to restore while streams are active, naming how many", async () => {
		stubs.push(stubMethod(databaseBackupService, "listBackups", () => Promise.resolve([BACKUP])));
		const service = new DatabaseRestoreService(() => 2);

		await expect(service.restore("nightly.sqlite", "/root", "reelvault.sqlite", "/cwd")).rejects.toMatchObject({
			code: "database.restore_blocked_active_streams",
			params: { activeStreams: 2 },
		});
	});
});
