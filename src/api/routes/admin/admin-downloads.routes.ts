import { AdminDownloadsResponseSchema, SuccessResponseSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { JobIdParams } from "@/api/schemas/route-params.schema";
import { downloadsService } from "@/modules/downloads/downloads.service";
import { adminShell } from "./admin-shell.routes";

export const adminDownloadsRoutes = adminShell({ prefix: "/downloads", tags: ["Admin"] })
	.get("/jobs", async ({ query }) => await downloadsService.listAllPage(query), {
		rateLimit: routeLimit("admin-downloads-jobs", 60),
		query: t.Composite([
			PaginationSchema,
			t.Object({
				status: t.Optional(
					t.Union([t.Literal("pending"), t.Literal("processing"), t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
				),
			}),
		]),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminDownloadsResponseSchema },
		detail: {
			description: "Page through all users' download jobs (admin overview), optionally filtered by status, with the counts per status.",
		},
	})
	.delete("/jobs/:jobId", async ({ params }) => await downloadsService.delete(params.jobId), {
		rateLimit: routeLimit("admin-downloads-delete", 30),
		params: JobIdParams,
		response: { 200: SuccessResponseSchema, 404: "error.response" },
		detail: { description: "Delete any user's download job and file (admin)." },
	});
