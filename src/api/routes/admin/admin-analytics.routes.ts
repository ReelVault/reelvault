import { AdminAnalyticsSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminAnalyticsService } from "@/application/admin/admin-analytics.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminAnalyticsRoutes = adminShell({ prefix: "/analytics", tags: ["Admin"] }).get(
	"",
	async ({ query }) => await adminAnalyticsService.getAnalytics(query.days),
	{
		rateLimit: { name: "admin-analytics", max: 60, windowMs: MINUTE },
		query: t.Object({
			days: t.Optional(t.Numeric({ minimum: 1, maximum: 365 })),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminAnalyticsSchema },
		detail: {
			description: "Retrieve comprehensive server-wide streaming and watch statistics for administrators.",
		},
	},
);
