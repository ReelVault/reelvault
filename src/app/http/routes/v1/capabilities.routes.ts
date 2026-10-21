import { ServerCapabilitiesSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { rateLimitMiddleware, routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { serverCapabilitiesService } from "@/app/server/server-capabilities.service";

export const capabilitiesRoutes = new Elysia({
	prefix: "/capabilities",
	tags: ["Capabilities"],
})
	.use(rateLimitMiddleware)
	.get("/", () => serverCapabilitiesService.get(), {
		rateLimit: routeLimit("capabilities", 120),
		response: { 200: ServerCapabilitiesSchema },
		detail: {
			description: "Public: which optional server features are switched on (trickplay, downloads). Needs no session.",
		},
	});
