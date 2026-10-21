import {
	AdminAuditOptionsSchema,
	AdminAuditPageSchema,
	AdminAuditSummarySchema,
	AdminCacheStatsSchema,
	AdminDashboardViewResponseSchema,
	AdminFfmpegCapabilitiesSchema,
	AdminFilesystemBrowseSchema,
	AdminResourcesResponseSchema,
	AdminStatsSchema,
	ImageCachePurgeResultSchema,
	MetadataProviderConfigurationSchema,
	OperationQueuedResponseSchema,
	PluginAdminStatusSchema,
	SystemSettingsGroupedSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminService } from "@/app/admin/admin.service";
import { adminAuditService } from "@/app/admin/admin-audit.service";
import { adminFfmpegCapabilitiesService } from "@/app/admin/admin-ffmpeg-capabilities.service";
import { adminResourcesService, RESOURCE_HISTORY_MAX_HOURS } from "@/app/admin/admin-resources.service";
import { metadataService } from "@/app/catalog/metadata/metadata.service";
import { metadataRefreshQueueService } from "@/app/catalog/metadata/refresh/metadata-refresh-queue.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { cached } from "@/app/http/middleware/response-cache.middleware";
import { BinaryResponseSchema, ClampedNumeric, paginationQueryFields, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { attachmentResponse } from "@/app/http/utils/binary-response.utils";
import { DomainError } from "@/utils/domain.errors";
import { RefreshMetadataSchema } from "./admin.schema";
import { adminShell } from "./admin-shell.routes";

/** Audit filters shared by the list and the export. */
const AuditFilterFields = {
	action: t.Optional(t.Union([t.Literal("create"), t.Literal("update"), t.Literal("delete")])),
	resourceType: t.Optional(t.String({ maxLength: 100 })),
	actorUserId: t.Optional(t.String({ maxLength: 128 })),
	ipAddress: t.Optional(t.String({ maxLength: 45 })),
	requestId: t.Optional(t.String({ maxLength: 128 })),
	q: t.Optional(t.String({ maxLength: 200 })),
	from: t.Optional(t.String({ format: "date-time" })),
	to: t.Optional(t.String({ format: "date-time" })),
};

/** The resource-history window both resource routes accept. */
const ResourceHistoryHours = t.Optional(ClampedNumeric(1, RESOURCE_HISTORY_MAX_HOURS, { default: 24 }));

export const adminSystemRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.refreshMetadata": RefreshMetadataSchema,
		"admin.stats": AdminStatsSchema,
		"admin.dashboardView": AdminDashboardViewResponseSchema,
		"admin.audit": AdminAuditPageSchema,
		"admin.filesystemBrowse": AdminFilesystemBrowseSchema,
	})
	.get("/filesystem/browse", async ({ query }) => await adminService.browseFilesystem(query.path), {
		query: t.Object({
			path: t.Optional(t.String()),
		}),
		rateLimit: routeLimit("admin-filesystem-browse", 30),
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
	.post("/image-cache/purge", async () => await adminService.purgeImageCache(), {
		rateLimit: routeLimit("admin-image-cache-purge", 10),
		response: { ...ROUTE_ERRORS.ADMIN, 200: ImageCachePurgeResultSchema },
		detail: {
			description:
				"Delete the optimized image copies. Originals are kept; each copy is rebuilt when it is requested again. Returns the files and bytes removed.",
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
				plugins: t.Array(PluginAdminStatusSchema),
				settings: SystemSettingsGroupedSchema,
			}),
			...ROUTE_ERRORS.ADMIN,
		},
		...cached({ maxAge: 10, private: true }),
		detail: {
			description: "Aggregate dashboard: stats, resource config, providers, plugins, and settings in one call.",
		},
	})
	.get("/dashboard-view", async () => await adminService.dashboardView(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.dashboardView" },
		...cached({ maxAge: 4, private: true }),
		detail: {
			description:
				"Admin dashboard composite: stats, libraries, recent worker operations, audit feed, error logs and update status in one call.",
		},
	})
	.get("/resources", async ({ query }) => await adminResourcesService.getResourcesView(query.hours), {
		query: t.Object({ hours: ResourceHistoryHours }),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminResourcesResponseSchema },
		// The monitoring page polls this continuously; a 2s body cache collapses
		// bursts (compression memoized) without hiding live movement.
		...cached({ maxAge: 2, private: true }),
		detail: {
			description: "Retrieve system resource metrics: CPU, memory, disk usage, alerts, and historical data for the last 24 hours.",
		},
	})
	.get(
		"/resources/export",
		async ({ query }) => {
			const exported = await adminResourcesService.exportHistory(query.hours, query.format);

			return attachmentResponse(exported.body, { filename: exported.filename, contentType: exported.contentType });
		},
		{
			rateLimit: routeLimit("admin-resources-export", 10),
			query: t.Object({
				hours: ResourceHistoryHours,
				format: t.Optional(t.Union([t.Literal("csv"), t.Literal("json")])),
			}),
			// Binary-style attachment: the handler returns a Response, not JSON.
			response: { ...ROUTE_ERRORS.ADMIN, ...BinaryResponseSchema },
			detail: {
				description: "Download every resource sample of the history window as CSV or JSON.",
			},
		},
	)
	.get("/ffmpeg-capabilities", () => adminFfmpegCapabilitiesService.getCapabilities(), {
		rateLimit: routeLimit("admin-ffmpeg-capabilities", 30),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminFfmpegCapabilitiesSchema },
		detail: {
			description:
				"Report what FFmpeg supports and which hardware accelerator the server actually uses: version, binary path, configured vs effective hwaccel, test-encode verification (with the failure reason), hardware APIs and encoders, and the detected DRM device.",
		},
	})
	.post("/ffmpeg-capabilities/refresh", async () => await adminFfmpegCapabilitiesService.refreshCapabilities(), {
		rateLimit: routeLimit("admin-ffmpeg-capabilities-refresh", 5),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminFfmpegCapabilitiesSchema },
		detail: {
			description:
				"Re-run FFmpeg capability detection (encoder/hwaccel probes plus the test encode) and additionally run a one-off hardware decode test on the effective accelerator.",
		},
	})
	.get("/audit", async ({ query }) => await adminAuditService.getAll(query), {
		query: t.Object({
			...paginationQueryFields({ maxLimit: 100 }),
			...AuditFilterFields,
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.audit" },
		...cached({ maxAge: 10, private: true }),
		detail: { description: "Retrieve administrator audit events with pagination and resource filters." },
	})
	.get("/audit/options", async () => await adminAuditService.getFilterOptions(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminAuditOptionsSchema },
		detail: { description: "Resource types and administrators in the audit log, for the audit filter dropdowns." },
	})
	.get("/audit/summary", async ({ query }) => await adminAuditService.getSummary(query), {
		rateLimit: routeLimit("admin-audit-summary", 60),
		query: t.Object({ ...AuditFilterFields, limit: t.Optional(ClampedNumeric(1, 50)) }),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminAuditSummarySchema },
		detail: { description: "Activity per administrator for the audit filters: totals per action and the latest entry." },
	})
	.get(
		"/audit/export",
		async ({ query }) => {
			const exported = await adminAuditService.exportEntries(query);

			return attachmentResponse(exported.body, { filename: exported.filename, contentType: exported.contentType });
		},
		{
			rateLimit: routeLimit("admin-audit-export", 10),
			query: t.Object({
				...AuditFilterFields,
				format: t.Optional(t.Union([t.Literal("csv"), t.Literal("jsonl")])),
			}),
			// Attachment download: the handler returns a Response, not JSON.
			response: { ...ROUTE_ERRORS.ADMIN, ...BinaryResponseSchema },
			detail: {
				description: "Download the audit entries matching the filters as CSV or JSON Lines, up to 10 000 entries.",
			},
		},
	)
	.delete(
		"/metadata/orphans",
		async ({ user, request }) => {
			return await metadataService.deleteOrphans(actorContext({ user, request }));
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
			const task = await metadataRefreshQueueService.queue(body, actorContext({ user, request }));
			if (!task)
				throw new DomainError("internal", "Metadata refresh operation was not created", { code: "admin.metadata.refresh_not_created" });

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
