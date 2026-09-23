import { HealthResponseSchema } from "@sdk/common";
import { Elysia, t } from "elysia";
import { healthService } from "@/application/health.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

export const healthRoutes = new Elysia({
	prefix: "/health",
	tags: ["Health"],
})
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"health.response": HealthResponseSchema,
	})
	.get(
		"/",
		async ({ query, status, user }) => {
			// `?fresh=true` bypasses the cache and runs synchronous DB/IO probes, so
			// it is admin-only. Anonymous liveness probes get the cached result;
			// the dedicated route limit still bounds request volume (the global
			// limiter exempts /health).
			const fresh = query.fresh === "true" && user?.role === "admin";
			const result = await healthService.check({ fresh });
			if (result.status === "degraded") {
				return status(503, result);
			}

			return result;
		},
		{
			rateLimit: { name: "health", max: 60, windowMs: MINUTE },
			query: t.Object({
				fresh: t.Optional(t.String()),
			}),
			response: {
				200: "health.response",
				503: "health.response",
			},
			detail: {
				description: "Check API health status and subsystem diagnostics. Use ?fresh=true (admin only) to bypass cache.",
			},
		},
	);
