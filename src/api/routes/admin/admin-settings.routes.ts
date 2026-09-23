import { ResetSystemSettingsSchema, SystemSettingsGroupedSchema, UpdateSystemSettingsSchema } from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminSettingsRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"admin.systemSettings": SystemSettingsGroupedSchema,
		"admin.updateSystemSettings": UpdateSystemSettingsSchema,
		"admin.resetSystemSettings": ResetSystemSettingsSchema,
	})
	.guard({ adminOnly: true })
	.get("/settings", async () => await systemSettingsService.getAll(), {
		rateLimit: { name: "admin-settings-get", max: 60, windowMs: 60_000 },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettings" },
		detail: {
			description: "Retrieve all dynamic system settings grouped by domain.",
		},
	})
	.patch(
		"/settings",
		async ({ body, user, request }) =>
			await systemSettingsService.updateSettings(body, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			rateLimit: { name: "admin-settings-update", max: 30, windowMs: 60_000 },
			body: "admin.updateSystemSettings",
			response: {
				...ROUTE_ERRORS.VALIDATED_ADMIN,
				200: "admin.systemSettings",
			},
			detail: {
				description: "Update one or more dynamic system settings in real time.",
			},
		},
	)
	.post(
		"/settings/reset",
		async ({ body, user, request }) =>
			await systemSettingsService.resetSettings(body.keys, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			rateLimit: { name: "admin-settings-reset", max: 10, windowMs: 60_000 },
			body: "admin.resetSystemSettings",
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettings" },
			detail: {
				description: "Reset specified system settings or all settings to their factory defaults.",
			},
		},
	);
