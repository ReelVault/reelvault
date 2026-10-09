import { ServerCapabilitiesSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { serverCapabilitiesService } from "@/application/server-capabilities.service";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

export const capabilitiesRoutes = new Elysia({
	prefix: "/capabilities",
	tags: ["Capabilities"],
})
	.use(rateLimitMiddleware)
	.get("/", () => serverCapabilitiesService.get(), {
		rateLimit: { name: "capabilities", max: 120, windowMs: MINUTE },
		response: { 200: ServerCapabilitiesSchema },
		detail: {
			description: "Public: which optional server features are switched on (trickplay, downloads). Needs no session.",
		},
	});
