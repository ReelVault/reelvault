import { RegisterResponseSchema, SetupAdminRequestSchema, SetupStatusSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { assertAuthRequestOrigin } from "@/api/middleware/auth-origin.guard";
import { rateLimitMiddleware, routeLimit } from "@/api/middleware/rate-limit.middleware";
import { commonModel } from "@/api/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { firstRunSetupService } from "@/services/auth/setup/first-run-setup.service";

export const setupRoutes = new Elysia({
	prefix: "/setup",
	tags: ["Setup"],
})
	.use(commonModel)
	.use(rateLimitMiddleware)
	.onBeforeHandle(({ request }) => assertAuthRequestOrigin(request))
	.model({
		"setup.admin.body": SetupAdminRequestSchema,
		"setup.status": SetupStatusSchema,
		"setup.admin.response": RegisterResponseSchema,
	})
	.get("/status", async () => await firstRunSetupService.getStatus(), {
		response: {
			200: "setup.status",
		},
		detail: {
			description: "Check whether the first-run server setup is still required.",
		},
	})
	.post("/", async ({ body, request }) => await firstRunSetupService.createAdminFromRequest(body, request.headers), {
		body: "setup.admin.body",
		// The setup token is the only credential — throttle guessing.
		rateLimit: routeLimit("setup:create-admin", 10, 15 * MINUTE),
		response: {
			200: "setup.admin.response",
			400: "error.response",
			403: "error.response",
			409: "error.response",
		},
		detail: {
			description:
				"Create the first administrator. Requires the x-setup-token header only when SETUP_TOKEN_ENABLED=true; otherwise the request completes setup directly.",
		},
	});
