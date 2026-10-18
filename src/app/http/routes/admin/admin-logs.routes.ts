import { AdminLogFileInfoSchema, AdminLogsPageSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminLogsService } from "@/app/admin/admin-logs.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { DomainError } from "@/utils/domain.errors";
import { AdminLogsQuerySchema } from "./admin.schema";
import { adminShell } from "./admin-shell.routes";

export const adminLogsRoutes = adminShell({ tags: ["Admin"] })
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
		"/logs/bundle",
		async () => {
			const { data, filename } = await adminLogsService.getLogBundle();

			return new Response(new Blob([data]), {
				headers: {
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="${filename}"`,
				},
			});
		},
		{
			rateLimit: { name: "admin-logs-bundle", max: 3, windowMs: MINUTE },
			response: {
				// Binary zip — handler returns a Response, not JSON.
				...ROUTE_ERRORS.ADMIN,
				200: t.Any(),
			},
			detail: {
				description: "Download every log file (rotated and debug included) as a zip archive for a support request.",
			},
		},
	)
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
			if (!query.fileId) throw new DomainError("validation", "Missing fileId", { code: "admin.logs.file_id_required" });

			return await adminLogsService.deleteLogFile(query.fileId, { actorUserId: user?.id, headers: request.headers });
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
			const dryRun = query.dryRun === true;
			const result = await adminLogsService.purgeOldLogs(
				query.retentionDays,
				{ actorUserId: user?.id, headers: request.headers },
				undefined,
				dryRun,
			);

			return { ...result, dryRun };
		},
		{
			query: t.Object({
				retentionDays: t.Optional(
					t.Numeric({ minimum: 1, maximum: 365, description: "Number of retention days (defaults to configured setting)." }),
				),
				dryRun: t.Optional(t.BooleanString({ description: "Count the log files that would be removed without removing them." })),
			}),
			response: {
				200: t.Object({
					scannedCount: t.Integer(),
					deletedCount: t.Integer(),
					freedBytes: t.Number(),
					retentionDays: t.Integer(),
					dryRun: t.Boolean(),
				}),
				...ROUTE_ERRORS.ADMIN,
			},
			detail: {
				description: "Purge log files older than the specified retention days (or configured default).",
			},
		},
	);
