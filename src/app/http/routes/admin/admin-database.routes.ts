import {
	AdminDatabaseBackupListSchema,
	AdminDatabaseBackupSchema,
	AdminDatabaseRestoreResponseSchema,
	DatabaseMigrationStatusSchema,
	SuccessResponseSchema,
} from "@reelvault/sdk/common";
import { file } from "bun";
import { t } from "elysia";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import { databaseBackupService } from "@/app/admin/database-backup.service";
import { databaseMaintenanceService } from "@/app/admin/database-maintenance.service";
import { databaseRestoreService } from "@/app/admin/database-restore.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { FileNameParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { attachmentResponse } from "@/app/http/utils/binary-response.utils";
import { env } from "@/config/env.config";
import { DATABASE_BACKUP_UPLOAD_MAX_SIZE, MINUTE } from "@/config/server/server.constants";
import { createLogger } from "@/utils/logger.utils";
import { adminShell } from "./admin-shell.routes";

const databaseRestoreLogger = createLogger("AdminDatabaseRestore");

export const adminDatabaseRoutes = adminShell({ tags: ["Admin"] })
	.get("/database/backups", async () => await databaseBackupService.listBackups(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminDatabaseBackupListSchema },
		detail: {
			description: "List existing SQLite database backups.",
		},
	})
	.post(
		"/database/backups",
		async ({ status, user, request }) => {
			const backup = await databaseBackupService.createBackup();
			recordAuditSafe(
				{
					action: "create",
					resourceType: "database_backup",
					resourceId: backup.fileName,
					summary: "origin: manual",
					after: { sizeBytes: backup.sizeBytes },
					context: actorContext({ user, request }),
				},
				databaseRestoreLogger,
			);

			return status(201, backup);
		},
		{
			rateLimit: { name: "admin-db-backup", max: 5, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.ADMIN, 201: AdminDatabaseBackupSchema },
			detail: {
				description: "Create an online SQLite database backup immediately using VACUUM INTO.",
			},
		},
	)
	.post(
		"/database/backups/upload",
		async ({ body, status, user, request }) => {
			const backup = await databaseBackupService.uploadBackup(body.file);
			recordAuditSafe(
				{
					action: "create",
					resourceType: "database_backup",
					resourceId: backup.fileName,
					summary: "origin: upload",
					after: { sizeBytes: backup.sizeBytes },
					context: actorContext({ user, request }),
				},
				databaseRestoreLogger,
			);

			return status(201, backup);
		},
		{
			rateLimit: { name: "admin-db-backup-upload", max: 5, windowMs: MINUTE },
			body: t.Object({ file: t.File({ maxSize: DATABASE_BACKUP_UPLOAD_MAX_SIZE }) }),
			response: { ...ROUTE_ERRORS.ADMIN, 201: AdminDatabaseBackupSchema },
			detail: {
				description: "Store an uploaded SQLite backup after a SQLite check. Refused unless system.database.backupUploadEnabled is on.",
			},
		},
	)
	.get(
		"/database/backups/:fileName/download",
		async ({ params }) => {
			const backup = await databaseBackupService.findBackupFile(params.fileName);

			return attachmentResponse(file(backup.path), {
				filename: backup.fileName,
				contentType: "application/vnd.sqlite3",
				headers: { "Content-Length": String(backup.sizeBytes) },
			});
		},
		{
			rateLimit: { name: "admin-db-backup-download", max: 10, windowMs: MINUTE },
			params: FileNameParams,
			// Attachment download: the handler returns a Response, not JSON.
			response: { ...ROUTE_ERRORS.ADMIN, 200: t.Any() },
			detail: {
				description: "Download an existing SQLite database backup as a file.",
			},
		},
	)
	.get("/database/migrations", async () => await databaseMaintenanceService.getMigrationStatus(), {
		rateLimit: { name: "admin-db-migrations", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: DatabaseMigrationStatusSchema },
		detail: { description: "Migration folders shipped with this server, and how many the database has applied." },
	})
	.get("/database/integrity", async () => await databaseMaintenanceService.checkIntegrity(), {
		rateLimit: { name: "admin-db-integrity", max: 10, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: t.Object({ ok: t.Boolean(), messages: t.Array(t.String()) }) },
		detail: {
			description: "Run SQLite's quick consistency check on the live database.",
		},
	})
	.post("/database/optimize", async () => await databaseMaintenanceService.optimize(), {
		rateLimit: { name: "admin-db-optimize", max: 5, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: SuccessResponseSchema },
		detail: {
			description: "Refresh SQLite's planner statistics (PRAGMA optimize).",
		},
	})
	.post(
		"/database/restore",
		async ({ body, request, status }) => {
			const result = await databaseRestoreService.restore(body.fileName, env.ROOT_DIR, env.DB_FILE_NAME, process.cwd(), {
				force: body.force,
			});
			recordAuditSafe(
				{
					action: "update",
					resourceType: "database_restore",
					resourceId: body.fileName,
					after: { restarting: result.restarting },
					context: { headers: request.headers },
				},
				databaseRestoreLogger,
			);

			return status(202, result);
		},
		{
			rateLimit: { name: "admin-db-restore", max: 3, windowMs: 10 * MINUTE },
			body: t.Object({ fileName: t.String({ minLength: 1 }), force: t.Optional(t.Boolean()) }),
			response: { ...ROUTE_ERRORS.ADMIN, 202: AdminDatabaseRestoreResponseSchema },
			detail: {
				description:
					"Queue a database restore from an existing backup. The current database is backed up first. The server shuts down, a detached helper swaps the database file and relaunches — expect a restart. Refused while streams are active unless `force` is set.",
			},
		},
	)
	.delete(
		"/database/backups/:fileName",
		async ({ params, user, request }) => {
			const success = await databaseBackupService.deleteBackup(params.fileName);
			if (success) {
				recordAuditSafe(
					{
						action: "delete",
						resourceType: "database_backup",
						resourceId: params.fileName,
						summary: "origin: manual",
						context: actorContext({ user, request }),
					},
					databaseRestoreLogger,
				);
			}

			return { success };
		},
		{
			params: FileNameParams,
			response: {
				...ROUTE_ERRORS.ADMIN,
				200: SuccessResponseSchema,
			},
			detail: {
				description: "Delete an existing database backup.",
			},
		},
	);
