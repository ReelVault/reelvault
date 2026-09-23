import { AdminDatabaseBackupListSchema, AdminDatabaseBackupSchema } from "@sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { databaseBackupService } from "@/application/admin/database-backup.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

export const adminDatabaseRoutes = new Elysia({ tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ adminOnly: true })
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
