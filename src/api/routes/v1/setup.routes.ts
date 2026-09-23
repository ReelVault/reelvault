import { ApiErrorResponseSchema, RegisterResponseSchema, SetupAdminRequestSchema, SetupStatusSchema } from "@sdk/common";
import { Elysia } from "elysia";
import { firstRunSetupService } from "@/application/auth/setup/first-run-setup.service";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

export const setupRoutes = new Elysia({
	prefix: "/setup",
	tags: ["Setup"],
})
	.use(rateLimitMiddleware)
	.model({
		"setup.admin.body": SetupAdminRequestSchema,
		"setup.status": SetupStatusSchema,
		"setup.admin.response": RegisterResponseSchema,
		"error.response": ApiErrorResponseSchema,
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
		rateLimit: { name: "setup:create-admin", max: 10, windowMs: 15 * MINUTE },
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
