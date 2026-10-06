import { ApiKeyCreatedSchema, ApiKeyListSchema, CreateApiKeyRequestSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { apiKeysService } from "@/application/admin/api-keys.service";
import { requireAdmin } from "@/middleware/auth.middleware";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminApiKeysRoutes = adminShell({ tags: ["Admin"] })
	.get("/api-keys", async () => await apiKeysService.list(), {
		rateLimit: { name: "admin-api-keys-list", max: 60, windowMs: MINUTE },
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
					{ actorUserId: user.id, headers: request.headers },
				),
			);
		},
		{
			rateLimit: { name: "admin-api-keys-create", max: 10, windowMs: MINUTE },
			body: CreateApiKeyRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN, 201: ApiKeyCreatedSchema },
			detail: {
				description: "Create an API key. The raw secret is returned exactly once and never persisted in clear text.",
			},
		},
	)
	.delete(
		"/api-keys/:id",
		async ({ params, user, request }) => {
			requireAdmin(user);
			await apiKeysService.revoke(params.id, { actorUserId: user.id, headers: request.headers });

			return { success: true };
		},
		{
			rateLimit: { name: "admin-api-keys-revoke", max: 30, windowMs: MINUTE },
			params: t.Object({ id: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN, 200: t.Object({ success: t.Boolean() }) },
			detail: {
				description: "Revoke an API key immediately.",
			},
		},
	);
