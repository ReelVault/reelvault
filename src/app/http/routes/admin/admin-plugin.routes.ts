import {
	CreatePluginRepositoryBodySchema,
	InstallCatalogPluginBodySchema,
	InstallCatalogPluginResponseSchema,
	MetadataProviderConfigurationSchema,
	PluginAdminStatusSchema,
	PluginBulkStateBodySchema,
	PluginBulkStateResultSchema,
	PluginCatalogResultSchema,
	PluginConfigDetailsSchema,
	PluginConfigExportSchema,
	PluginCspUpdateBodySchema,
	PluginPinUpdateBodySchema,
	PluginRepositorySchema,
	PluginUiSettingsSchema,
	PluginValidationResultSchema,
	ReorderMetadataProvidersSchema,
	ResetPluginConfigBodySchema,
	UpdatePluginConfigBodySchema,
	UpdatePluginRepositoryBodySchema,
	UpdatePluginUiSettingsBodySchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminService } from "@/app/admin/admin.service";
import { adminPluginCatalogService } from "@/app/admin/admin-plugin-catalog.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { PluginArchiveUpload, PluginIdParams, ProviderIdParams, RepositoryIdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { MINUTE } from "@/config/server/server.constants";
import { adminShell } from "./admin-shell.routes";

export const adminPluginRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.plugins": t.Array(PluginAdminStatusSchema),
		"admin.plugin": PluginAdminStatusSchema,
		"admin.pluginConfig": PluginConfigDetailsSchema,
		"admin.pluginRepositories": t.Array(PluginRepositorySchema),
		"admin.pluginRepository": PluginRepositorySchema,
		"admin.pluginCatalog": PluginCatalogResultSchema,
		"admin.updatePluginConfig": UpdatePluginConfigBodySchema,
		"admin.pluginConfigExport": PluginConfigExportSchema,
		"admin.resetPluginConfig": ResetPluginConfigBodySchema,
		"admin.pluginCsp": PluginCspUpdateBodySchema,
		"admin.pluginBulkState": PluginBulkStateBodySchema,
		"admin.pluginPin": PluginPinUpdateBodySchema,
		"admin.pluginBulkStateResult": PluginBulkStateResultSchema,
		"admin.pluginUiSettings": PluginUiSettingsSchema,
		"admin.updatePluginUiSettings": UpdatePluginUiSettingsBodySchema,
		"admin.metadataProviderConfigurations": t.Array(MetadataProviderConfigurationSchema),
	})
	.get("/plugins", async () => await adminService.plugins(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.plugins" },
		detail: {
			description: "List plugin runtime status and the phase of any failed load without exposing configuration values.",
		},
	})
	.post("/plugins/reload", async ({ user, request }) => await adminService.reloadPlugins(actorContext({ user, request })), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.plugins" },
		detail: {
			description: "Reloads all discovered plugins from the plugins directory.",
		},
	})
	.get("/plugins/:pluginId", ({ params }) => adminService.getPlugin(params.pluginId), {
		params: PluginIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.plugin" },
		detail: {
			description: "Get the runtime status of a specific plugin.",
		},
	})
	.post(
		"/plugins/:pluginId/reload",
		async ({ params, user, request }) => await adminService.reloadPlugin(params.pluginId, actorContext({ user, request })),
		{
			params: PluginIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description: "Reloads a specific plugin by unregistering and re-executing its lifecycle.",
			},
		},
	)
	.get("/plugins/:pluginId/ui", async ({ params }) => await adminService.getPluginUiSettings(params.pluginId), {
		params: PluginIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginUiSettings" },
		detail: { description: "List the UI contributions of a plugin with their on/off state, plus the plugin-wide master switch." },
	})
	.put(
		"/plugins/:pluginId/ui",
		async ({ params, body, user, request }) =>
			await adminService.updatePluginUiSettings(params.pluginId, body, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.updatePluginUiSettings",
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginUiSettings" },
			detail: {
				description:
					"Hide parts of a plugin's UI (or all of it). Contributions not listed stay visible; an unknown key is rejected with plugin_ui.unknown_contribution.",
			},
		},
	)
	.delete(
		"/plugins/:pluginId/ui",
		async ({ params, user, request }) => await adminService.resetPluginUiSettings(params.pluginId, actorContext({ user, request })),
		{
			params: PluginIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginUiSettings" },
			detail: { description: "Show every part of a plugin's UI again." },
		},
	)
	.post(
		"/plugins/:pluginId/enable",
		async ({ params, user, request }) => await adminService.enablePlugin(params.pluginId, actorContext({ user, request })),
		{
			params: PluginIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description: "Loads and enables a specific plugin.",
			},
		},
	)
	.post(
		"/plugins/:pluginId/disable",
		async ({ params, user, request }) => await adminService.disablePlugin(params.pluginId, actorContext({ user, request })),
		{
			params: PluginIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description: "Disables and unloads a specific plugin.",
			},
		},
	)
	.get("/providers", async () => await adminService.getMetadataProviderConfigurations(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.metadataProviderConfigurations" },
		detail: { description: "List metadata providers with their priority and enabled state." },
	})
	.patch(
		"/providers/:providerId",
		async ({ params, body, user, request }) =>
			await adminService.updateMetadataProviderConfiguration(params.providerId, body, actorContext({ user, request })),
		{
			params: ProviderIdParams,
			body: t.Object({
				priority: t.Optional(t.Integer({ minimum: 0, maximum: 10000 })),
				enabled: t.Optional(t.Boolean()),
			}),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: MetadataProviderConfigurationSchema },
			detail: { description: "Update metadata provider priority or enabled state." },
		},
	)
	.put(
		"/providers/order",
		async ({ body, user, request }) =>
			await adminService.reorderMetadataProviderConfigurations(body.providerIds, actorContext({ user, request })),
		{
			body: ReorderMetadataProvidersSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: "admin.metadataProviderConfigurations" },
			detail: { description: "Reorder metadata providers by priority (first = highest priority)." },
		},
	)
	.get("/plugins/:pluginId/config", async ({ params }) => await adminService.pluginConfig(params.pluginId), {
		params: PluginIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginConfig" },
		detail: {
			description: "Retrieve a plugin configuration with schema fields descriptor and sanitized values.",
		},
	})
	.put(
		"/plugins/:pluginId/config",
		async ({ params, body, user, request }) =>
			await adminService.updatePluginConfig(params.pluginId, body, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.updatePluginConfig",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.pluginConfig" },
			detail: {
				description: "Update plugin configuration, store values, and hot reload the plugin.",
			},
		},
	)
	.post(
		"/plugins/:pluginId/config/reset",
		async ({ params, body, user, request }) => await adminService.resetPluginConfig(params.pluginId, body, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.resetPluginConfig",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.pluginConfig" },
			detail: {
				description:
					"Restore the defaults for the listed configuration fields, or for every stored value when no keys are given. Reloads the plugin.",
			},
		},
	)
	.post("/plugins/bulk", async ({ body, user, request }) => await adminService.setPluginsEnabled(body, actorContext({ user, request })), {
		body: "admin.pluginBulkState",
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: "admin.pluginBulkStateResult" },
		detail: {
			description: "Enable or disable several plugins at once. Each plugin is attempted on its own and reported in the result.",
		},
	})
	.put(
		"/plugins/:pluginId/pin",
		async ({ params, body, user, request }) =>
			await adminService.setPluginPinned(params.pluginId, body.pinned, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.pluginPin",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description:
					"Keep the installed version of a plugin, so the catalog offers no update for it, or allow updates again. Installed plugins only.",
			},
		},
	)
	.put(
		"/plugins/:pluginId/csp",
		async ({ params, body, user, request }) =>
			await adminService.setPluginCspEnabled(params.pluginId, body.enabled, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.pluginCsp",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description: "Allow or refuse the content-security-policy sources the plugin declares. Installed plugins only; applies at once.",
			},
		},
	)
	.get("/plugins/:pluginId/config/export", async ({ params }) => await adminService.exportPluginConfig(params.pluginId), {
		params: PluginIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginConfigExport" },
		detail: { description: "Export the plugin configuration without its secret fields." },
	})
	.post(
		"/plugins/:pluginId/config/import",
		async ({ params, body, user, request }) =>
			await adminService.importPluginConfig(params.pluginId, body, actorContext({ user, request })),
		{
			params: PluginIdParams,
			body: "admin.pluginConfigExport",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.pluginConfig" },
			detail: {
				description:
					"Apply an exported plugin configuration. Secret fields in the file are ignored; everything else is validated and the plugin reloads.",
			},
		},
	)
	.get("/plugins/repositories", async () => await adminPluginCatalogService.listRepositories(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.pluginRepositories" },
		detail: {
			description: "List catalog repositories (manifest sources). Access tokens are never returned.",
		},
	})
	.post(
		"/plugins/repositories",
		async ({ body, user, request }) => await adminPluginCatalogService.createRepository(body, actorContext({ user, request })),
		{
			body: CreatePluginRepositoryBodySchema,
			rateLimit: { name: "admin-plugin-repository-create", max: 10, windowMs: MINUTE },
			response: {
				...ROUTE_ERRORS.VALIDATED_ADMIN,
				200: "admin.pluginRepository",
			},
			detail: {
				description: "Add a plugin catalog repository. An optional access token enables private repositories (stored encrypted).",
			},
		},
	)
	.patch(
		"/plugins/repositories/:repositoryId",
		async ({ params, body, user, request }) =>
			await adminPluginCatalogService.updateRepository(params.repositoryId, body, actorContext({ user, request })),
		{
			params: RepositoryIdParams,
			body: UpdatePluginRepositoryBodySchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.pluginRepository" },
			detail: {
				description: "Rename a repository, change its URL/token, or toggle it.",
			},
		},
	)
	.delete(
		"/plugins/repositories/:repositoryId",
		async ({ params, user, request }) =>
			await adminPluginCatalogService.deleteRepository(params.repositoryId, actorContext({ user, request })),
		{
			params: RepositoryIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Remove a catalog repository. Installed plugins are not uninstalled.",
			},
		},
	)
	.post(
		"/plugins/repositories/:repositoryId/refresh",
		async ({ params, user, request }) =>
			await adminPluginCatalogService.refreshRepository(params.repositoryId, actorContext({ user, request })),
		{
			params: RepositoryIdParams,
			rateLimit: { name: "admin-plugin-repository-refresh", max: 10, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.pluginRepository" },
			detail: {
				description: "Re-fetch the repository manifest immediately (bypasses the cache).",
			},
		},
	)
	.get("/plugins/catalog", async () => await adminPluginCatalogService.getCatalog(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.pluginCatalog" },
		detail: {
			description: "Aggregated catalog across enabled repositories with per-plugin install status.",
		},
	})
	.post(
		"/plugins/catalog/install",
		async ({ body, user, request }) => await adminPluginCatalogService.install(body, actorContext({ user, request })),
		{
			body: InstallCatalogPluginBodySchema,
			rateLimit: { name: "admin-plugin-install", max: 5, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: InstallCatalogPluginResponseSchema },
			detail: {
				description:
					"Download, checksum-verify and install (or upgrade) a plugin from a catalog repository, then enable it. Runs third-party code — admin only.",
			},
		},
	)
	.post("/plugins/validate", async ({ body }) => await adminPluginCatalogService.validateUploadedArchive(body.file), {
		body: PluginArchiveUpload,
		rateLimit: { name: "admin-plugin-validate", max: 10, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: PluginValidationResultSchema },
		detail: {
			description:
				"Check an uploaded .zip / .tar / .tar.gz plugin archive without installing it: manifest, entry point, interface manifest, server floor, and what installing it would change. Read-only.",
		},
	})
	.post(
		"/plugins/install-upload",
		async ({ body, user, request }) => await adminPluginCatalogService.installUploadedArchive(body.file, actorContext({ user, request })),
		{
			body: PluginArchiveUpload,
			rateLimit: { name: "admin-plugin-install-upload", max: 10, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: InstallCatalogPluginResponseSchema },
			detail: {
				description: "Install (or upgrade) a plugin from an uploaded .zip / .tar / .tar.gz archive. Runs third-party code — admin only.",
			},
		},
	)
	.post(
		"/plugins/:pluginId/uninstall",
		async ({ params, user, request }) => await adminPluginCatalogService.uninstall(params.pluginId, actorContext({ user, request })),
		{
			params: PluginIdParams,
			rateLimit: { name: "admin-plugin-uninstall", max: 10, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Uninstall an installer-managed plugin: unload it, remove its directory, lockfile entry and stored data.",
			},
		},
	);
