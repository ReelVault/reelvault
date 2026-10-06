import { ResetSystemSettingsSchema, SystemSettingsGroupedSchema, UpdateSystemSettingsSchema } from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminSettingsRoutes = adminShell()
	.model({
		"admin.systemSettings": SystemSettingsGroupedSchema,
		"admin.updateSystemSettings": UpdateSystemSettingsSchema,
		"admin.resetSystemSettings": ResetSystemSettingsSchema,
	})
	.get("/settings", async () => await systemSettingsService.getAll(), {
		rateLimit: { name: "admin-settings-get", max: 60, windowMs: MINUTE },
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
			rateLimit: { name: "admin-settings-update", max: 30, windowMs: MINUTE },
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
			rateLimit: { name: "admin-settings-reset", max: 10, windowMs: MINUTE },
			body: "admin.resetSystemSettings",
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettings" },
			detail: {
				description: "Reset specified system settings or all settings to their factory defaults.",
			},
		},
	);
