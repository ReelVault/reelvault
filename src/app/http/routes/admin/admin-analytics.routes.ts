import { AdminAnalyticsSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminAnalyticsService } from "@/app/admin/admin-analytics.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { adminShell } from "./admin-shell.routes";

export const adminAnalyticsRoutes = adminShell({ prefix: "/analytics", tags: ["Admin"] }).get(
	"",
	async ({ query }) => await adminAnalyticsService.getAnalytics(query.days),
	{
		rateLimit: routeLimit("admin-analytics", 60),
		query: t.Object({
			days: t.Optional(t.Numeric({ minimum: 1, maximum: 365 })),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminAnalyticsSchema },
		detail: {
			description: "Retrieve comprehensive server-wide streaming and watch statistics for administrators.",
		},
	},
);
