import {
	CreatePlaybackSessionSchema,
	IdempotencyKeyHeadersSchema,
	MyPlaybackSessionsResponseSchema,
	PlaybackDiagnosticsSchema,
	PlaybackSessionSchema,
	PlaybackViewResponseSchema,
	StreamHeartbeatResponseSchema,
	StreamSeekResponseSchema,
	TranscodeProgressResponseSchema,
} from "@sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { MediaFileIdParams, SessionIdParams } from "@/api/schemas/route-params";
import { withEtagResponse } from "@/api/utils/etag.utils";
import { playbackViewService } from "@/application/media/playback-view.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { assertSessionAccess, assertSessionOwnershipById } from "@/modules/streaming/sessions/session-access.guard";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { playbackStreamingService } from "@/modules/streaming/streaming.service";
import { MINUTE } from "@/server.constants";

export const playbackSessionsRoutes = new Elysia({ prefix: "/playback-sessions", tags: ["Playback Sessions"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ auth: true })
	.get(
		"/view/:mediaFileId",
		async ({ params, profile, request, set }) =>
			withEtagResponse(request, set, () => playbackViewService.getPlaybackView(params.mediaFileId, profile?.id), {
				// Progress/user-state changes are invalidated per profile by
				// invalidateProfileResponseBodies() on progress writes.
				cacheKey: `playback-view:${params.mediaFileId}:${profile?.id ?? "anon"}`,
			}),
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: PlaybackViewResponseSchema },
			deduplicate: {},
			detail: { description: "Get complete initial payload for starting playback (file, metadata, subtitles, markers, resume progress)." },
		},
	)
	.get("/mine", async ({ profile }) => await playbackStreamingService.listMine(profile?.id), {
		response: { ...ROUTE_ERRORS.AUTH, 200: MyPlaybackSessionsResponseSchema },
		detail: { description: "List the calling profile's active playback sessions (remote-control page)." },
	})
	.post(
		"/",
		async ({ body, headers, status, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: body.mediaFileId });

			return status(201, await playbackStreamingService.createPlaybackSession(body, profile?.id, headers["idempotency-key"], user?.id));
		},
		{
			rateLimit: { name: "playback-session", max: 30, windowMs: MINUTE },
			body: CreatePlaybackSessionSchema,
			headers: IdempotencyKeyHeadersSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_CONFLICT_RATE_LIMITED, 201: PlaybackSessionSchema },
			detail: { description: "Create one idempotent, profile-owned HLS playback session." },
		},
	)
	.get(
		"/:sessionId/playlist",
		async ({ params, set, profile, request }) => {
			assertSessionOwnershipById(params.sessionId, profile?.id);
			set.headers["Content-Type"] = "application/x-mpegURL";
			set.headers["Cache-Control"] = "no-store";

			return await playbackStreamingService.getPlaylist(params.sessionId, request.signal);
		},
		{
			params: SessionIdParams,
			// Binary HLS manifest — handler returns a Response (m3u8 body), not JSON.
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Any() },
			detail: { description: "Get the HLS manifest for an active playback session." },
		},
	)
	.get(
		"/:sessionId/segments/:segment",
		async ({ params, request, set, profile }) => {
			assertSessionOwnershipById(params.sessionId, profile?.id);
			set.headers["Content-Type"] = params.segment === "init.mp4" ? "video/mp4" : "video/iso.segment";
			set.headers["Cache-Control"] = "no-store";

			// Aborted clients must release the server-side segment wait (and never
			// trigger a fast seek) instead of holding it for the full timeout.
			return await playbackStreamingService.getSegment(params.sessionId, params.segment, request.signal);
		},
		{
			params: t.Object({ sessionId: t.String(), segment: t.String() }),
			// Binary HLS segment — handler returns a Response (fMP4 body), not JSON.
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Any() },
			detail: { description: "Get an HLS fMP4 initialization or media segment." },
		},
	)
	.post(
		"/:sessionId/seek",
		async ({ params, body, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);

			return await playbackStreamingService.seek(params.sessionId, body.position);
		},
		{
			// The seek scheduler already debounces (300 ms) and serializes per
			// session; this caps a client that hammers non-buffered seeks, each of
			// which triggers a full ffmpeg restart. 5/s sustained is well above
			// human scrubbing and far below the global IP budget.
			rateLimit: { name: "playback-seek", max: 300, windowMs: MINUTE },
			params: SessionIdParams,
			// Server clamps missing/null/non-finite positions into [0, duration].
			body: t.Object({ position: t.Optional(t.Nullable(t.Number())) }),
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: StreamSeekResponseSchema },
		},
	)
	.get(
		"/:sessionId/transcode-progress",
		async ({ params, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);

			return await playbackStreamingService.getTranscodeProgress(params.sessionId);
		},
		{
			params: SessionIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: TranscodeProgressResponseSchema },
			detail: { description: "How far the server has gotten transcoding/remuxing the file for this session." },
		},
	)
	.get(
		"/:sessionId/diagnostics",
		async ({ params, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);

			return await playbackStreamingService.getDiagnostics(params.sessionId);
		},
		{
			params: SessionIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: PlaybackDiagnosticsSchema },
		},
	)
	.post(
		"/:sessionId/heartbeat",
		async ({ params, body, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);

			return await playbackStreamingService.heartbeat(params.sessionId, body);
		},
		{
			params: SessionIdParams,
			// Optional piggy-backed playback progress — saves the client a second
			// request on every heartbeat interval.
			body: t.Object({
				position: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
				audioStreamIndex: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
				subtitleId: t.Optional(t.Nullable(t.String())),
				duration: t.Optional(t.Nullable(t.Number({ minimum: 0 }))),
				isPaused: t.Optional(t.Nullable(t.Boolean())),
			}),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: StreamHeartbeatResponseSchema },
		},
	)
	.delete(
		"/:sessionId",
		async ({ params, set, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);
			playbackStreamingService.releasePlaybackSession(params.sessionId);
			set.status = 204;

			return null;
		},
		{
			params: SessionIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 204: t.Null() },
			detail: { description: "Release a playback session without waiting for asynchronous cleanup." },
		},
	);
