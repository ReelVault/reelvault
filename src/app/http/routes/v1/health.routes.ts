import { HealthLiveResponseSchema, HealthResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/app/http/middleware/rate-limit.middleware";
import { healthService } from "@/app/server/health.service";
import { MINUTE } from "@/config/server/server.constants";
import { coerceBoolean } from "@/utils/type.utils";

export const healthRoutes = new Elysia({
	prefix: "/health",
	tags: ["Health"],
})
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"health.response": HealthResponseSchema,
	})
	.get("/live", () => ({ status: "ok" as const, uptime: process.uptime() }), {
		rateLimit: { name: "health-live", max: 120, windowMs: MINUTE },
		response: { 200: HealthLiveResponseSchema },
		detail: { description: "Liveness probe: the process is up. Probes no dependency, so it never fails while the server runs." },
	})
	.get(
		"/ready",
		async ({ status }) => {
			const result = await healthService.checkReady();

			return result.status === "ok" ? result : status(503, result);
		},
		{
			rateLimit: { name: "health-ready", max: 120, windowMs: MINUTE },
			response: { 200: "health.response", 503: "health.response" },
			detail: { description: "Readiness probe: 200 when the database responds, 503 otherwise. Public and unauthenticated." },
		},
	)
	.get(
		"/",
		async ({ query, status, user }) => {
			// `?fresh=true` bypasses the cache and runs synchronous DB/IO probes, so
			// it is admin-only. Anonymous liveness probes get the cached result;
			// the dedicated route limit still bounds request volume (the global
			// limiter exempts /health).
			const fresh = coerceBoolean(query.fresh) && user?.role === "admin";
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
