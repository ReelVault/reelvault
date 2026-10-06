import { AdminDatabaseBackupListSchema, AdminDatabaseBackupSchema, AdminDatabaseRestoreResponseSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { databaseRestoreService } from "@/application/admin/database-restore.service";
import { env } from "@/env";
import { MINUTE } from "@/server.constants";
import { createLogger } from "@/utils/logger";
import { adminShell } from "./admin-shell";

const databaseRestoreLogger = createLogger("AdminDatabaseRestore");

export const adminDatabaseRoutes = adminShell({ tags: ["Admin"] })
	.get("/database/backups", async () => await databaseBackupService.listBackups(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminDatabaseBackupListSchema },
		detail: {
			description: "List existing SQLite database backups.",
		},
	})
	.post("/database/backups", async ({ status }) => status(201, await databaseBackupService.createBackup()), {
		rateLimit: { name: "admin-db-backup", max: 5, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 201: AdminDatabaseBackupSchema },
		detail: {
			description: "Create an online SQLite database backup immediately using VACUUM INTO.",
		},
	})
	.post(
		"/database/restore",
		async ({ body, request, status }) => {
			const result = await databaseRestoreService.restore(body.fileName, env.ROOT_DIR, env.DB_FILE_NAME, process.cwd());
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
			body: t.Object({ fileName: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN, 202: AdminDatabaseRestoreResponseSchema },
			detail: {
				description:
					"Queue a database restore from an existing backup. The server shuts down, a detached helper swaps the database file and relaunches — expect a restart.",
			},
		},
	)
	.delete(
		"/database/backups/:fileName",
		async ({ params }) => {
			const success = await databaseBackupService.deleteBackup(params.fileName);

			return { success };
		},
		{
			params: t.Object({ fileName: t.String() }),
			response: {
				...ROUTE_ERRORS.ADMIN,
				200: t.Object({ success: t.Boolean() }),
			},
			detail: {
				description: "Delete an existing database backup.",
			},
		},
	);
