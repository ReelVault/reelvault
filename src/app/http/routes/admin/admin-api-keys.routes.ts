import {
	ApiKeyCreatedSchema,
	ApiKeyListSchema,
	ApiKeySchema,
	CreateApiKeyRequestSchema,
	SuccessResponseSchema,
	UpdateApiKeyRequestSchema,
} from "@reelvault/sdk/common";
import { apiKeysService } from "@/app/admin/api-keys.service";
import { requireAdmin } from "@/app/http/middleware/auth.middleware";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { IdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { adminShell } from "./admin-shell.routes";

export const adminApiKeysRoutes = adminShell({ tags: ["Admin"] })
	.get("/api-keys", async () => await apiKeysService.list(), {
		rateLimit: routeLimit("admin-api-keys-list", 60),
		response: { ...ROUTE_ERRORS.ADMIN, 200: ApiKeyListSchema },
		detail: {
			description: "List machine integration API keys (secrets are never returned — only prefixes).",
		},
	})
	.post(
		"/api-keys",
		async ({ body, user, request, status }) => {
			requireAdmin(user);

			return status(
				201,
				await apiKeysService.create(
					{
						name: body.name,
						scope: body.scope,
						expiresAtDays: body.expiresAtDays,
						creatorUserId: user.id,
					},
					actorContext({ user, request }),
				),
			);
		},
		{
			rateLimit: routeLimit("admin-api-keys-create", 10),
			body: CreateApiKeyRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN, 201: ApiKeyCreatedSchema },
			detail: {
				description: "Create an API key. The raw secret is returned exactly once and never persisted in clear text.",
			},
		},
	)
	.patch(
		"/api-keys/:id",
		async ({ params, body, user, request }) => await apiKeysService.update(params.id, body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-api-keys-update", 30),
			params: IdParams,
			body: UpdateApiKeyRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN, 200: ApiKeySchema },
			detail: {
				description: "Rename an API key or change its expiry. The secret does not change; rotate the key for a new one.",
			},
		},
	)
	.post(
		"/api-keys/:id/rotate",
		async ({ params, user, request }) => await apiKeysService.rotate(params.id, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-api-keys-rotate", 10),
			params: IdParams,
			response: { ...ROUTE_ERRORS.ADMIN, 200: ApiKeyCreatedSchema },
			detail: {
				description: "Replace an API key's secret. The new secret is returned exactly once and the old one stops working at once.",
			},
		},
	)
	.delete(
		"/api-keys/:id",
		async ({ params, user, request }) => {
			await apiKeysService.revoke(params.id, actorContext({ user, request }));

			return { success: true };
		},
		{
			rateLimit: routeLimit("admin-api-keys-revoke", 30),
			params: IdParams,
			response: { ...ROUTE_ERRORS.ADMIN, 200: SuccessResponseSchema },
			detail: {
				description: "Revoke an API key immediately.",
			},
		},
	);
