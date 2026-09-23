import {
	MediaMarkerSchema,
	OperationQueuedResponseSchema,
	PlaybackArtifactSchema,
	ProjectedResponseSchema,
	SetMediaMarkersSchema,
} from "@sdk/common";
import {
	CreateMediaFileSchema,
	MediaFileAuditStatusSchema,
	MediaFileFiltersSchema,
	MediaFileSortingSchema,
	MediaFileWithRelationSchema,
	ReassignMediaFileSchema,
	UpdateMediaFileSchema,
} from "@sdk/common/media-file.types";
import { Elysia, t } from "elysia";
import {
	ClampedNumeric,
	commonModel,
	FieldsSchema,
	PaginatedResponseSchema,
	PaginationSchema,
	ROUTE_ERRORS,
} from "@/api/schemas/common.schemas";
import { MediaFileIdParams, OperationIdParams } from "@/api/schemas/route-params";
import { mediaService } from "@/application/media/media-files/media-files.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { MINUTE } from "@/server.constants";

export const mediaFilesRoutes = new Elysia({
	prefix: "/media-files",
	tags: ["Media Files"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		// Keep requested relation fields (e.g. audioStreams) in the serialized response.
		"media-file.schema": ProjectedResponseSchema(MediaFileWithRelationSchema),
		"media-files.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(MediaFileWithRelationSchema)),
		"media-files.create.body": CreateMediaFileSchema,
		"media-files.update.body": UpdateMediaFileSchema,
		"media-files.reassign.body": ReassignMediaFileSchema,
		"media-files.audit.status": MediaFileAuditStatusSchema,
	})
	.guard({ auth: true })
	.get(
		"/audit",
		async ({ status, user, request }) => status(202, await mediaService.queueAudit({ actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			rateLimit: {
				name: "media-files-audit",
				max: 10,
				windowMs: MINUTE,
			},
			deduplicate: {},
			response: { ...ROUTE_ERRORS.ADMIN, 202: OperationQueuedResponseSchema },
			detail: {
				description:
					"Queue a full media-file audit (metadata mismatches, sequel errors, year discrepancies). Returns 202; poll GET /media-files/audit/:operationId for the report.",
			},
		},
	)
	.get("/audit/:operationId", async ({ params }) => await mediaService.getAuditStatus(params.operationId), {
		adminOnly: true,
		params: OperationIdParams,
		response: { ...ROUTE_ERRORS.ADMIN, 200: "media-files.audit.status" },
		detail: {
			description: "Poll a queued media-file audit operation; `result` is populated once it completes.",
		},
	})
	.get("/", async ({ query }) => await mediaService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, MediaFileFiltersSchema, MediaFileSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "media-files.paginated.schema" },
		detail: {
			description: "Retrieve a paginated list of media files with extensive filtering by library, metadata, and technical properties.",
		},
	})
	.post(
		"/refresh",
		async ({ status, user, request }) => status(202, await mediaService.refreshAll({ actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			rateLimit: {
				name: "media-files-refresh-all",
				max: 1,
				windowMs: 5 * MINUTE,
			},
			response: { ...ROUTE_ERRORS.AUTH, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Queue a refresh of technical data and linked metadata for all media files.",
			},
		},
	)
	.get(
		"/markers",
		async ({ query }) => {
			return await mediaService.listAllMarkers(query.limit);
		},
		{
			adminOnly: true,
			query: t.Object({
				limit: t.Optional(ClampedNumeric(1, 1000)),
			}),
			response: { ...ROUTE_ERRORS.ADMIN, 200: t.Array(MediaMarkerSchema) },
			detail: {
				description: "List all timeline markers across all media files. Optional limit trims the result after fetching.",
			},
		},
	)
	.get(
		"/:mediaFileId/artifacts",
		async ({ params, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: params.mediaFileId });

			return await mediaService.listArtifacts(params.mediaFileId);
		},
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Array(PlaybackArtifactSchema) },
			detail: {
				description: "List artifacts generated for a media file by core or plugins.",
			},
		},
	)
	.get(
		"/:mediaFileId/artifacts/:artifactId",
		async ({ params, set, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: params.mediaFileId });
			const { artifact, file } = await mediaService.getArtifact(params.mediaFileId, params.artifactId);
			set.headers["Content-Type"] = artifact.contentType;
			set.headers["Cache-Control"] = "public, max-age=86400, immutable";

			return file;
		},
		{
			params: t.Object({
				mediaFileId: t.String(),
				artifactId: t.String(),
			}),
			response: {
				// Binary artifact body — handler returns a Response (streamed file), not JSON.
				...ROUTE_ERRORS.ADMIN_NOT_FOUND,
				200: t.Any(),
			},
			detail: {
				description: "Read an artifact through the server without exposing its storage path.",
			},
		},
	)
	.get(
		"/:mediaFileId/markers",
		async ({ params, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: params.mediaFileId });

			return await mediaService.listMarkers(params.mediaFileId);
		},
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Array(MediaMarkerSchema) },
			detail: {
				description: "List timeline markers (intro, credits, chapters, recap) for a media file.",
			},
		},
	)
	.post(
		"/:mediaFileId/markers",
		async ({ params, body, user, request }) => {
			return await mediaService.setMarkers(params.mediaFileId, body.markers, undefined, {
				actorUserId: user?.id,
				headers: request.headers,
			});
		},
		{
			adminOnly: true,
			params: MediaFileIdParams,
			body: SetMediaMarkersSchema,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: t.Array(MediaMarkerSchema) },
			detail: {
				description: "Set or replace timeline markers for a media file.",
			},
		},
	)
	.delete(
		"/:mediaFileId/markers",
		async ({ params, user, request }) => {
			return await mediaService.deleteMarkers(params.mediaFileId, { actorUserId: user?.id, headers: request.headers });
		},
		{
			adminOnly: true,
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Delete all timeline markers for a media file.",
			},
		},
	)
	.get("/:mediaFileId", async ({ params, query }) => await mediaService.getById(params.mediaFileId, query), {
		params: MediaFileIdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "media-file.schema" },
		detail: {
			description: "Retrieve technical details about a specific media file by its ID.",
		},
	})
	.post(
		"/:mediaFileId/refresh",
		async ({ params, status, user, request }) =>
			status(202, await mediaService.refresh(params.mediaFileId, { actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Refresh technical stream data with ffprobe and metadata from the linked provider.",
			},
		},
	)
	.post(
		"/:mediaFileId/scan",
		async ({ params, body }) => {
			return await mediaService.scan(params.mediaFileId, body);
		},
		{
			adminOnly: true,
			rateLimit: {
				name: "media-file-scan",
				max: 10,
				windowMs: MINUTE,
			},
			params: MediaFileIdParams,
			body: t.Optional(
				t.Object({
					durationSeconds: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
				}),
			),
			response: {
				200: t.Object({
					exists: t.Boolean(),
					readable: t.Boolean(),
					sizeBytes: t.Nullable(t.Integer()),
					probeSuccess: t.Boolean(),
					probeError: t.Nullable(t.String()),
					decodeSuccess: t.Boolean(),
					decodeError: t.Nullable(t.String()),
					isEnabled: t.Boolean(),
				}),
				...ROUTE_ERRORS.NOT_FOUND,
			},
			detail: {
				description: "Verify media file existence, readability, ffprobe compatibility, and run a quick decode integrity check.",
			},
		},
	)
	.delete(
		"/:mediaFileId",
		async ({ params, user, request }) => await mediaService.delete(params.mediaFileId, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Remove a media file record from the database. This does not delete the physical file.",
			},
		},
	)
	.patch(
		"/:mediaFileId",
		async ({ params, body, query, user, request }) =>
			await mediaService.update(params.mediaFileId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MediaFileIdParams,
			body: "media-files.update.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "media-file.schema" },
			detail: {
				description: "Modify an existing media file record's metadata or associations.",
			},
		},
	)
	.post(
		"/:mediaFileId/reassign",
		async ({ params, body, query, user, request }) =>
			await mediaService.reassign(params.mediaFileId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MediaFileIdParams,
			body: "media-files.reassign.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "media-file.schema" },
			detail: {
				description: "Reassign a media file to different metadata (either existing in library or newly imported from a provider).",
			},
		},
	);
