import {
	MetadataProviderConfigurationSchema,
	MetadataProviderSearchRequestSchema,
	MetadataProviderSearchResponseSchema,
	MetadataProviderStatusSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { pluginsService } from "@/application/plugins.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { MINUTE } from "@/server.constants";

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
	.get("/", () => pluginsService.getProviderStatus(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(MetadataProviderStatusSchema) },
		detail: {
			description: "Retrieve a list of all available metadata providers and their current status (enabled/configured).",
		},
	})
	.get("/configurations", async () => await pluginsService.getProviderConfigurations(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(MetadataProviderConfigurationSchema) },
		detail: {
			description:
				"Retrieve metadata provider configurations (priority and enabled flag) — lets clients pick a provider, e.g. for identify-by-id.",
		},
	})
	.post("/search", async ({ body }) => await pluginsService.searchProviders(body), {
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
