import { ProjectedResponseSchema } from "@reelvault/sdk";
import { DiscoverResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { ClampedNumeric, commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { discoverService } from "@/application/users/discover.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

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
	.guard({ auth: true })
	.get("/", async ({ query, profile }) => await discoverService.getDiscoverView(query, profile?.id), {
		rateLimit: {
			name: "discover",
			max: 30,
			windowMs: MINUTE,
		},
		query: t.Object({
			limit: t.Optional(ClampedNumeric(1, 50, { default: 10 })),
		}),
		response: { ...ROUTE_ERRORS.AUTH, 200: "discover.response" },
		// The service already caches the per-profile view for 60 s; this caches the
		// rendered body on top so repeat views skip serialization/validation too.
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve items for the home dashboard, including recently added movies and TV shows.",
		},
	});
