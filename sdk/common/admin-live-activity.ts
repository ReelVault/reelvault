import type { Static } from "@sinclair/typebox";
import { t } from "elysia";
import { PlaybackReasonsSchema } from "./stream";

export const AdminLiveStreamItemSchema = t.Object({
	sessionId: t.String(),
	profileId: t.String(),
	profileName: t.String(),
	profileAvatar: t.Nullable(t.String()),
	userId: t.String(),
	userName: t.String(),
	userEmail: t.String(),
	mediaFileId: t.String(),
	metadataId: t.String(),
	title: t.String(),
	type: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
	releaseYear: t.Nullable(t.Number()),
	seasonNumber: t.Nullable(t.Number()),
	episodeNumber: t.Nullable(t.Number()),
	episodeTitle: t.Nullable(t.String()),
	posterUrl: t.Nullable(t.String()),
	/** Version of the poster image — feeds the client's image cache key. */
	posterUpdatedAt: t.Nullable(t.Date()),
	backdropUrl: t.Nullable(t.String()),
	currentTime: t.Number(),
	duration: t.Number(),
	progressPercent: t.Number(),
	mode: t.Union([t.Literal("direct-stream"), t.Literal("transcode")]),
	videoTranscode: t.Boolean(),
	audioTranscode: t.Boolean(),
	videoEncoder: t.String(),
	audioEncoder: t.String(),
	hwaccel: t.String(),
	transcodeReasons: t.Nullable(PlaybackReasonsSchema),
	videoCodec: t.Nullable(t.String()),
	videoProfile: t.Nullable(t.String()),
	width: t.Nullable(t.Integer()),
	height: t.Nullable(t.Integer()),
	frameRate: t.Nullable(t.String()),
	pixelFormat: t.Nullable(t.String()),
	bitrateKbps: t.Nullable(t.Number()),
	targetVideoBitrateKbps: t.Nullable(t.Number()),
	audioStreamIndex: t.Nullable(t.Integer()),
	audioCodec: t.Nullable(t.String()),
	audioChannels: t.Nullable(t.Integer()),
	audioChannelLayout: t.Nullable(t.String()),
	audioLanguage: t.Nullable(t.String()),
	audioTitle: t.Nullable(t.String()),
	processId: t.Nullable(t.Integer()),
	bufferedSeconds: t.Nullable(t.Number()),
	bufferedUntil: t.Nullable(t.Number()),
	bufferState: t.Nullable(t.String()),
	/** ffmpeg encode position/speed from the transcode progress monitor (distinct from the viewer's playback position). */
	encodePositionSeconds: t.Nullable(t.Number({ minimum: 0 })),
	encodePercent: t.Nullable(t.Number({ minimum: 0, maximum: 100 })),
	encodeSpeed: t.Nullable(t.String()),
	clientName: t.Nullable(t.String()),
	browser: t.Nullable(t.String()),
	os: t.Nullable(t.String()),
	ipAddress: t.Nullable(t.String()),
	startedAt: t.String(),
	lastActivityAt: t.String(),
});

export type AdminLiveStreamItem = Static<typeof AdminLiveStreamItemSchema>;

export const AdminActiveDeviceItemSchema = t.Object({
	sessionId: t.String(),
	userId: t.String(),
	userName: t.String(),
	userEmail: t.String(),
	ipAddress: t.Nullable(t.String()),
	userAgent: t.Nullable(t.String()),
	clientName: t.String(),
	browser: t.String(),
	os: t.String(),
	lastSeenAt: t.String(),
});

export type AdminActiveDeviceItem = Static<typeof AdminActiveDeviceItemSchema>;

export const AdminLiveWarningSchema = t.Object({
	code: t.String(),
	params: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
});

export const AdminLiveActivityResponseSchema = t.Object({
	activeStreams: t.Array(AdminLiveStreamItemSchema),
	activeDevices: t.Array(AdminActiveDeviceItemSchema),
	canSafelyUpdate: t.Boolean(),
	/** Machine code + params — the frontend renders the warning text. */
	warning: t.Optional(t.Nullable(AdminLiveWarningSchema)),
});

export type AdminLiveActivityResponse = Static<typeof AdminLiveActivityResponseSchema>;
