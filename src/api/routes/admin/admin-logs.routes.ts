import { AdminLogFileInfoSchema, AdminLogsPageSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminLogsService } from "@/application/admin/admin-logs.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";
import { ValidationError } from "@/utils/errors";
import { AdminLogsQuerySchema } from "./admin.schema";

export const adminLogsRoutes = new Elysia({ tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ adminOnly: true })
	.get("/logs/files", async () => await adminLogsService.listLogFiles(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: t.Array(AdminLogFileInfoSchema) },
		detail: {
			description: "Retrieve a list of all server and FFmpeg log files.",
		},
	})
	.get("/logs", async ({ query }) => await adminLogsService.getLogs(query), {
		query: AdminLogsQuerySchema,
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminLogsPageSchema },
		detail: {
			description: "Retrieve server log entries with level filtering, search, and pagination.",
		},
	})
	.get(
		"/logs/download",
		async ({ query }) => {
			const { file, filename } = await adminLogsService.getLogFileDownloadContent(query.fileId);

			return new Response(file, {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"content-disposition": `attachment; filename="${filename}"`,
				},
			});
		},
		{
			query: t.Object({
				fileId: t.Optional(t.String()),
			}),
			rateLimit: { name: "admin-logs-download", max: 10, windowMs: MINUTE },
			response: {
				// Plain-text log download — handler returns a Response, not JSON.
				...ROUTE_ERRORS.ADMIN,
				200: t.Any(),
			},
			detail: {
				description: "Download a specific log file as plain text.",
			},
		},
	)
	.delete(
		"/logs",
		async ({ query, user, request }) => {
			if (!query.fileId) throw new ValidationError("Missing fileId", { code: "admin.logs.file_id_required" });

			return await adminLogsService.deleteLogFile(query.fileId, user?.id, request.headers);
		},
		{
			query: t.Object({
				fileId: t.String({ description: "Path or identifier of the log file to delete." }),
			}),
			response: {
				...ROUTE_ERRORS.ADMIN_NOT_FOUND,
				200: t.Object({ success: t.Boolean() }),
			},
			detail: {
				description: "Delete a server or FFmpeg log file.",
			},
		},
	)
	.delete(
		"/logs/cleanup",
		async ({ query, user, request }) => {
			return await adminLogsService.purgeOldLogs(query.retentionDays, { actorUserId: user?.id, headers: request.headers });
		},
		{
			query: t.Object({
				retentionDays: t.Optional(
					t.Numeric({ minimum: 1, maximum: 365, description: "Number of retention days (defaults to configured setting)." }),
				),
			}),
			response: {
				200: t.Object({
					scannedCount: t.Integer(),
					deletedCount: t.Integer(),
					freedBytes: t.Number(),
					retentionDays: t.Integer(),
				}),
				...ROUTE_ERRORS.ADMIN,
			},
			detail: {
				description: "Purge log files older than the specified retention days (or configured default).",
			},
		},
	);
