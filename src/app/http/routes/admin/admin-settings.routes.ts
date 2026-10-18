import {
	ImportSystemSettingsSchema,
	ResetSystemSettingsSchema,
	SystemSettingsExportSchema,
	SystemSettingsGroupedSchema,
	UpdateSystemSettingsSchema,
} from "@reelvault/sdk/common";
import { systemSettingsService } from "@/app/admin/system-settings.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { MINUTE } from "@/config/server/server.constants";
import { adminShell } from "./admin-shell.routes";

export const adminSettingsRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.systemSettings": SystemSettingsGroupedSchema,
		"admin.updateSystemSettings": UpdateSystemSettingsSchema,
		"admin.resetSystemSettings": ResetSystemSettingsSchema,
		"admin.systemSettingsExport": SystemSettingsExportSchema,
		"admin.importSystemSettings": ImportSystemSettingsSchema,
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
	.get("/settings/export", async () => await systemSettingsService.exportSettings(), {
		rateLimit: { name: "admin-settings-export", max: 10, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettingsExport" },
		detail: {
			description: "Export the current value of every dynamic system setting as a versioned JSON document.",
		},
	})
	.post(
		"/settings/import",
		async ({ body, user, request }) =>
			await systemSettingsService.importSettings(body, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			rateLimit: { name: "admin-settings-import", max: 10, windowMs: MINUTE },
			body: "admin.importSystemSettings",
			response: {
				...ROUTE_ERRORS.VALIDATED_ADMIN,
				200: "admin.systemSettings",
			},
			detail: {
				description: "Import a settings export. Listed settings are validated and applied together; unlisted settings keep their values.",
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
