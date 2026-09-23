import { RemoteAccessDiagnosticsSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { remoteAccessService } from "@/application/admin/remote-access.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminNetworkRoutes = new Elysia({ prefix: "/network", tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ adminOnly: true })
	.get("/remote-access", async () => await remoteAccessService.getDiagnostics(), {
		rateLimit: { name: "admin-network-remote-access", max: 30, windowMs: 60_000 },
		response: { ...ROUTE_ERRORS.ADMIN, 200: RemoteAccessDiagnosticsSchema },
		detail: { description: "Remote-access configuration checks and generated reverse-proxy snippets." },
	});
