import {
	ApiKeyCreatedSchema,
	ApiKeyListSchema,
	ApiKeySchema,
	CreateApiKeyRequestSchema,
	UpdateApiKeyRequestSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { apiKeysService } from "@/app/admin/api-keys.service";
import { requireAdmin } from "@/app/http/middleware/auth.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { adminShell } from "./admin-shell.routes";

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
	.patch(
		"/api-keys/:id",
		async ({ params, body, user, request }) => {
			requireAdmin(user);

			return await apiKeysService.update(params.id, body, { actorUserId: user.id, headers: request.headers });
		},
		{
			rateLimit: { name: "admin-api-keys-update", max: 30, windowMs: MINUTE },
			params: t.Object({ id: t.String({ minLength: 1 }) }),
			body: UpdateApiKeyRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN, 200: ApiKeySchema },
			detail: {
				description: "Rename an API key or change its expiry. The secret does not change; rotate the key for a new one.",
			},
		},
	)
	.post(
		"/api-keys/:id/rotate",
		async ({ params, user, request }) => {
			requireAdmin(user);

			return await apiKeysService.rotate(params.id, { actorUserId: user.id, headers: request.headers });
		},
		{
			rateLimit: { name: "admin-api-keys-rotate", max: 10, windowMs: MINUTE },
			params: t.Object({ id: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN, 200: ApiKeyCreatedSchema },
			detail: {
				description: "Replace an API key's secret. The new secret is returned exactly once and the old one stops working at once.",
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
