import { AdminAnalyticsSchema } from "@sdk/common";
import Elysia, { t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminAnalyticsService } from "@/application/admin/admin-analytics.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminAnalyticsRoutes = new Elysia({ prefix: "/analytics", tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ adminOnly: true })
	.get(
		"",
		async ({ query }) => {
			const days = query.days === undefined || query.days === 0 ? undefined : query.days;

			return await adminAnalyticsService.getAnalytics(days);
		},
		{
			rateLimit: { name: "admin-analytics", max: 60, windowMs: 60_000 },
			query: t.Object({
				days: t.Optional(t.Numeric({ minimum: 1, maximum: 365 })),
			}),
			response: { ...ROUTE_ERRORS.ADMIN, 200: AdminAnalyticsSchema },
			detail: {
				description: "Retrieve comprehensive server-wide streaming and watch statistics for administrators.",
			},
		},
	);
