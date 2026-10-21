import {
	ImportSystemSettingsSchema,
	ResetSystemSettingsSchema,
	SystemSettingsExportSchema,
	SystemSettingsGroupedSchema,
	UpdateSystemSettingsSchema,
} from "@reelvault/sdk/common";
import { systemSettingsService } from "@/app/admin/system-settings.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
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
		rateLimit: routeLimit("admin-settings-get", 60),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettings" },
		detail: {
			description: "Retrieve all dynamic system settings grouped by domain.",
		},
	})
	.patch(
		"/settings",
		async ({ body, user, request }) => await systemSettingsService.updateSettings(body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-settings-update", 30),
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
		rateLimit: routeLimit("admin-settings-export", 10),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettingsExport" },
		detail: {
			description: "Export the current value of every dynamic system setting as a versioned JSON document.",
		},
	})
	.post(
		"/settings/import",
		async ({ body, user, request }) => await systemSettingsService.importSettings(body, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-settings-import", 10),
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
		async ({ body, user, request }) => await systemSettingsService.resetSettings(body.keys, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-settings-reset", 10),
			body: "admin.resetSystemSettings",
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.systemSettings" },
			detail: {
				description: "Reset specified system settings or all settings to their factory defaults.",
			},
		},
	);
