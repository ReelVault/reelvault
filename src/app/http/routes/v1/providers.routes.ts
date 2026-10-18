import {
	MetadataProviderConfigurationSchema,
	MetadataProviderSearchRequestSchema,
	MetadataProviderSearchResponseSchema,
	MetadataProviderStatusSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { commonModel, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { providerService } from "@/plugins/capabilities/provider.service";

export const providersRoutes = new Elysia({
	prefix: "/providers",
	tags: ["Providers"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"provider.search.body": MetadataProviderSearchRequestSchema,
	})
	.guard({ auth: true })
	.get("/", () => providerService.getAll(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(MetadataProviderStatusSchema) },
		detail: {
			description: "Retrieve a list of all available metadata providers and their current status (enabled/configured).",
		},
	})
	.get("/configurations", async () => await providerService.getConfigurations(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(MetadataProviderConfigurationSchema) },
		detail: {
			description:
				"Retrieve metadata provider configurations (priority and enabled flag) — lets clients pick a provider, e.g. for identify-by-id.",
		},
	})
	.post("/search", async ({ body }) => await providerService.search(body), {
		rateLimit: {
			name: "provider-search",
			max: 30,
			windowMs: MINUTE,
		},
		body: "provider.search.body",
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(MetadataProviderSearchResponseSchema) },
		detail: {
			description: "Search for movies or TV shows across all enabled metadata providers.",
		},
	});
