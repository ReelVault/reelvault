import { ServerCapabilitiesSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { rateLimitMiddleware } from "@/app/http/middleware/rate-limit.middleware";
import { serverCapabilitiesService } from "@/app/server/server-capabilities.service";
import { MINUTE } from "@/config/server/server.constants";

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
