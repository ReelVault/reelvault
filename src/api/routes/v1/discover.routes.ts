import { ProjectedResponseSchema } from "@reelvault/sdk";
import { DiscoverResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/api/middleware/auth.middleware";
import { rateLimitMiddleware, routeLimit } from "@/api/middleware/rate-limit.middleware";
import { cached } from "@/api/middleware/response-cache.middleware";
import { ClampedNumeric, commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { discoverService } from "@/services/users/discover.service";

export const discoverRoutes = new Elysia({
	prefix: "/discover",
	tags: ["Discover"],
})
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"discover.response": ProjectedResponseSchema(DiscoverResponseSchema),
	})
	.guard({ auth: true, profileRequired: true })
	.get("/", async ({ query, profile }) => await discoverService.getDiscoverView(query, profile?.id), {
		rateLimit: routeLimit("discover", 30),
		query: t.Object({
			limit: t.Optional(ClampedNumeric(1, 50, { default: 10 })),
		}),
		response: { ...ROUTE_ERRORS.AUTH, 200: "discover.response" },
		// The service already caches the per-profile view for 60 s; this caches the
		// rendered body on top so repeat views skip serialization/validation too.
		...cached({ maxAge: 60, private: true }),
		detail: {
			description: "Retrieve items for the home dashboard, including recently added movies and TV shows.",
		},
	});
