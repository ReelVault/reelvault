import {
	CreatePluginRepositoryBodySchema,
	InstallCatalogPluginBodySchema,
	InstallCatalogPluginResponseSchema,
	MetadataProviderConfigurationSchema,
	PluginCatalogEntrySchema,
	PluginConfigDetailsSchema,
	PluginRepositorySchema,
	PluginRuntimeStatusSchema,
	ReorderMetadataProvidersSchema,
	UpdatePluginConfigBodySchema,
	UpdatePluginRepositoryBodySchema,
} from "@sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { PluginIdParams, RepositoryIdParams } from "@/api/schemas/route-params";
import { adminService } from "@/application/admin/admin.service";
import { adminPluginCatalogService } from "@/application/admin/admin-plugin-catalog.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

export const adminPluginRoutes = new Elysia({ tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"admin.plugins": t.Array(PluginRuntimeStatusSchema),
		"admin.plugin": PluginRuntimeStatusSchema,
		"admin.pluginConfig": PluginConfigDetailsSchema,
		"admin.pluginRepositories": t.Array(PluginRepositorySchema),
		"admin.pluginRepository": PluginRepositorySchema,
		"admin.pluginCatalog": t.Array(PluginCatalogEntrySchema),
		"admin.updatePluginConfig": UpdatePluginConfigBodySchema,
		"admin.metadataProviderConfigurations": t.Array(MetadataProviderConfigurationSchema),
	})
	.guard({ adminOnly: true })
	.get("/plugins", async () => await adminService.plugins(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.plugins" },
		detail: {
			description: "List plugin runtime status and the phase of any failed load without exposing configuration values.",
		},
	})
	.post("/plugins/reload", async ({ user, request }) => await adminService.reloadPlugins(user?.id, request.headers), {
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
		async ({ params, user, request }) => await adminService.reloadPlugin(params.pluginId, user?.id, request.headers),
		{
			params: PluginIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.plugin" },
			detail: {
				description: "Reloads a specific plugin by unregistering and re-executing its lifecycle.",
			},
		},
	)
	.post(
		"/plugins/:pluginId/enable",
		async ({ params, user, request }) => await adminService.enablePlugin(params.pluginId, user?.id, request.headers),
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
		async ({ params, user, request }) => await adminService.disablePlugin(params.pluginId, user?.id, request.headers),
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
			await adminService.updateMetadataProviderConfiguration(params.providerId, body, user?.id, request.headers),
		{
			params: t.Object({ providerId: t.String({ minLength: 1, maxLength: 128 }) }),
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
			await adminService.reorderMetadataProviderConfigurations(body.providerIds, user?.id, request.headers),
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
		async ({ params, body, user, request }) => await adminService.updatePluginConfig(params.pluginId, body, user?.id, request.headers),
		{
			params: PluginIdParams,
			body: "admin.updatePluginConfig",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.pluginConfig" },
			detail: {
				description: "Update plugin configuration, store values, and hot reload the plugin.",
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
		async ({ body, user, request }) =>
			await adminPluginCatalogService.createRepository(body, { actorUserId: user?.id, headers: request.headers }),
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
			await adminPluginCatalogService.updateRepository(params.repositoryId, body, { actorUserId: user?.id, headers: request.headers }),
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
			await adminPluginCatalogService.deleteRepository(params.repositoryId, { actorUserId: user?.id, headers: request.headers }),
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
			await adminPluginCatalogService.refreshRepository(params.repositoryId, { actorUserId: user?.id, headers: request.headers }),
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
		async ({ body, user, request }) => await adminPluginCatalogService.install(body, { actorUserId: user?.id, headers: request.headers }),
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
	.post(
		"/plugins/install-upload",
		async ({ body, user, request }) =>
			await adminPluginCatalogService.installUploadedArchive(body.file, { actorUserId: user?.id, headers: request.headers }),
		{
			body: t.Object({ file: t.File({ maxSize: "200m" }) }),
			rateLimit: { name: "admin-plugin-install-upload", max: 10, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: InstallCatalogPluginResponseSchema },
			detail: {
				description: "Install (or upgrade) a plugin from an uploaded .zip / .tar / .tar.gz archive. Runs third-party code — admin only.",
			},
		},
	)
	.post(
		"/plugins/:pluginId/uninstall",
		async ({ params, user, request }) =>
			await adminPluginCatalogService.uninstall(params.pluginId, { actorUserId: user?.id, headers: request.headers }),
		{
			params: PluginIdParams,
			rateLimit: { name: "admin-plugin-uninstall", max: 10, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Uninstall an installer-managed plugin: unload it, remove its directory, lockfile entry and stored data.",
			},
		},
	);
