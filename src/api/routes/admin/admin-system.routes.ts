import {
	AdminAuditPageSchema,
	AdminCacheStatsSchema,
	AdminDatabaseBackupListSchema,
	AdminDatabaseBackupSchema,
	AdminFfmpegCapabilitiesSchema,
	AdminFilesystemBrowseSchema,
	AdminLogsPageSchema,
	AdminResourcesResponseSchema,
	AdminStatsSchema,
	MetadataProviderConfigurationSchema,
	OperationQueuedResponseSchema,
	PluginCatalogEntrySchema,
	PluginConfigDetailsSchema,
	PluginRepositorySchema,
	PluginRuntimeStatusSchema,
	UpdatePluginConfigBodySchema,
} from "@sdk/common";
import { SystemSettingsGroupedSchema } from "@sdk/common/settings";
import { Elysia, t } from "elysia";
import { ClampedNumeric, commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { adminService } from "@/application/admin/admin.service";
import { adminAuditService } from "@/application/admin/admin-audit.service";
import { adminFfmpegCapabilitiesService } from "@/application/admin/admin-ffmpeg-capabilities.service";
import { adminResourcesService } from "@/application/admin/admin-resources.service";
import { metadataService } from "@/application/catalog/metadata/metadata.service";
import { metadataRefreshQueueService } from "@/application/catalog/metadata/metadata-refresh-queue.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";
import { InternalError } from "@/utils/errors";
import { RefreshMetadataSchema } from "./admin.schema";

export const adminSystemRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"admin.refreshMetadata": RefreshMetadataSchema,
		"admin.stats": AdminStatsSchema,
		"admin.plugins": t.Array(PluginRuntimeStatusSchema),
		"admin.plugin": PluginRuntimeStatusSchema,
		"admin.pluginConfig": PluginConfigDetailsSchema,
		"admin.pluginRepositories": t.Array(PluginRepositorySchema),
		"admin.pluginRepository": PluginRepositorySchema,
		"admin.pluginCatalog": t.Array(PluginCatalogEntrySchema),
		"admin.updatePluginConfig": UpdatePluginConfigBodySchema,
		"admin.metadataProviderConfigurations": t.Array(MetadataProviderConfigurationSchema),
		"admin.logs": AdminLogsPageSchema,
		"admin.audit": AdminAuditPageSchema,
		"admin.filesystemBrowse": AdminFilesystemBrowseSchema,
		"admin.databaseBackups": AdminDatabaseBackupListSchema,
		"admin.databaseBackup": AdminDatabaseBackupSchema,
	})
	.guard({ adminOnly: true })
	.use(rateLimitMiddleware)
	.get("/filesystem/browse", async ({ query }) => await adminService.browseFilesystem(query.path), {
		query: t.Object({
			path: t.Optional(t.String()),
		}),
		rateLimit: { name: "admin-filesystem-browse", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.filesystemBrowse" },
		detail: {
			description: "Browse directories on the server filesystem for library configuration.",
		},
	})
	.get("/stats", async () => await adminService.stats(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.stats" },
		detail: {
			description: "Retrieve runtime server information: memory usage, uptime, active streaming sessions, and queue health.",
		},
	})
	.get("/cache-stats", async () => await adminService.cacheStats(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminCacheStatsSchema },
		detail: {
			description:
				"Retrieve server cache statistics: disk usage of transcode, image, and subtitle caches plus in-memory cache entry counts and hit rates.",
		},
	})
	.get("/dashboard", async () => await adminService.dashboard(), {
		response: {
			200: t.Object({
				stats: AdminStatsSchema,
				resources: t.Object({
					monitoringEnabled: t.Boolean(),
					memoryThresholdPercent: t.Number(),
					diskThresholdPercent: t.Number(),
					enableDynamicThrottling: t.Boolean(),
				}),
				providers: t.Array(MetadataProviderConfigurationSchema),
				plugins: t.Array(PluginRuntimeStatusSchema),
				settings: SystemSettingsGroupedSchema,
			}),
			...ROUTE_ERRORS.ADMIN,
		},
		cache: { maxAge: 10, private: true },
		deduplicate: {},
		detail: {
			description: "Aggregate dashboard: stats, resource config, providers, plugins, and settings in one call.",
		},
	})
	.get("/resources", async () => await adminResourcesService.getResourcesView(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminResourcesResponseSchema },
		detail: {
			description: "Retrieve system resource metrics: CPU, memory, disk usage, alerts, and historical data for the last 24 hours.",
		},
	})
	.get("/ffmpeg-capabilities", () => adminFfmpegCapabilitiesService.getCapabilities(), {
		rateLimit: { name: "admin-ffmpeg-capabilities", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminFfmpegCapabilitiesSchema },
		detail: {
			description:
				"Report what FFmpeg supports and which hardware accelerator the server actually uses: version, binary path, configured vs effective hwaccel, test-encode verification (with the failure reason), hardware APIs and encoders, and the detected DRM device.",
		},
	})
	.post("/ffmpeg-capabilities/refresh", async () => await adminFfmpegCapabilitiesService.refreshCapabilities(), {
		rateLimit: { name: "admin-ffmpeg-capabilities-refresh", max: 5, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminFfmpegCapabilitiesSchema },
		detail: {
			description:
				"Re-run FFmpeg capability detection (encoder/hwaccel probes plus the test encode) and additionally run a one-off hardware decode test on the effective accelerator.",
		},
	})
	.get("/audit", async ({ query }) => await adminAuditService.getAll(query), {
		query: t.Object({
			page: t.Optional(t.Numeric({ minimum: 1 })),
			limit: t.Optional(ClampedNumeric(1, 100)),
			action: t.Optional(t.Union([t.Literal("create"), t.Literal("update"), t.Literal("delete")])),
			resourceType: t.Optional(t.String({ maxLength: 100 })),
			actorUserId: t.Optional(t.String({ maxLength: 128 })),
			ipAddress: t.Optional(t.String({ maxLength: 45 })),
			requestId: t.Optional(t.String({ maxLength: 128 })),
			from: t.Optional(t.String({ format: "date-time" })),
			to: t.Optional(t.String({ format: "date-time" })),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.audit" },
		cache: { maxAge: 10, private: true },
		deduplicate: {},
		detail: { description: "Retrieve administrator audit events with pagination and resource filters." },
	})
	.delete(
		"/metadata/orphans",
		async ({ user, request }) => {
			return await metadataService.deleteOrphans({ actorUserId: user?.id, headers: request.headers });
		},
		{
			response: {
				...ROUTE_ERRORS.ADMIN,
				200: t.Object({ count: t.Integer() }),
			},
			detail: {
				description: "Remove orphan metadata records without linked media files.",
			},
		},
	)
	.post(
		"/refresh-metadata",
		async ({ body, status, user, request }) => {
			const task = await metadataRefreshQueueService.queue(body, { actorUserId: user?.id, headers: request.headers });
			if (!task) throw new InternalError("Metadata refresh operation was not created", { code: "admin.metadata.refresh_not_created" });

			return status(202, {
				success: true,
				operationId: task.operationId,
				status: "pending",
			});
		},
		{
			body: "admin.refreshMetadata",
			response: { ...ROUTE_ERRORS.ADMIN, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Manually trigger a metadata refresh task for one metadata entry.",
			},
		},
	);
