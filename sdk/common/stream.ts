import { t } from "elysia";

export const PlaybackModeSchema = t.Union([t.Literal("direct-stream"), t.Literal("transcode")]);

export const PlaybackReasonSchema = t.Object({
	code: t.String(),
	params: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
});

export const PlaybackReasonsSchema = t.Object({ video: PlaybackReasonSchema, audio: PlaybackReasonSchema });

export const PlaybackSessionResponseSchema = t.Object({
	operationId: t.String(),
	mode: PlaybackModeSchema,
	sessionId: t.String(),
	playUrl: t.String(),
	reasons: PlaybackReasonsSchema,
	audioStreamIndex: t.Nullable(t.Integer({ minimum: 0 })),
	subtitleLanguage: t.Nullable(t.String()),
	subtitlesEnabled: t.Boolean(),
	forcedSubtitlesOnly: t.Boolean(),
	subtitleId: t.Nullable(t.String()),
	subtitleStreamIndex: t.Nullable(t.Integer({ minimum: 0 })),
	subtitleType: t.Nullable(t.Union([t.Literal("embedded"), t.Literal("external")])),
});

export type PlaybackSessionResponse = typeof PlaybackSessionResponseSchema.static;

export const StreamSeekResponseSchema = t.Object({
	position: t.Number({ minimum: 0 }),
	startTime: t.Number({ minimum: 0 }),
	reusedBuffer: t.Boolean(),
});

export type StreamSeekResponse = typeof StreamSeekResponseSchema.static;

export const TranscodeRangeSchema = t.Object({
	startTime: t.Number({ minimum: 0 }),
	endTime: t.Number({ minimum: 0 }),
	startSegment: t.Integer({ minimum: 0 }),
	endSegment: t.Integer({ minimum: 0 }),
	segmentCount: t.Integer({ minimum: 1 }),
});

export type TranscodeRange = typeof TranscodeRangeSchema.static;

/** How far the server has gotten transcoding/remuxing the file — NOT what the player has buffered. */
export const TranscodeProgressResponseSchema = t.Object({
	sessionId: t.String(),
	mediaFileId: t.String(),
	state: t.Union([t.Literal("pending"), t.Literal("transcoding"), t.Literal("completed")]),
	active: t.Boolean(),
	segmentDuration: t.Number({ exclusiveMinimum: 0 }),
	segments: t.Integer({ minimum: 0 }),
	transcodedSeconds: t.Number({ minimum: 0 }),
	transcodedUntil: t.Number({ minimum: 0 }),
	duration: t.Nullable(t.Number({ minimum: 0 })),
	remainingSeconds: t.Nullable(t.Number({ minimum: 0 })),
	progressPercent: t.Nullable(t.Number({ minimum: 0, maximum: 100 })),
	ranges: t.Array(TranscodeRangeSchema),
});

export type TranscodeProgressResponse = typeof TranscodeProgressResponseSchema.static;

export const PlaybackProgressItemSchema = t.Object({
	mediaFileId: t.String(),
	position: t.Number({ minimum: 0 }),
	duration: t.Number({ minimum: 0 }),
	completed: t.Boolean(),
	audioStreamIndex: t.Optional(t.Union([t.Nullable(t.Integer({ minimum: 0 })), t.Undefined()])),
	subtitleId: t.Optional(t.Union([t.Nullable(t.String()), t.Undefined()])),
	updatedAt: t.String({ format: "date-time" }),
});

export type PlaybackProgressItemContract = typeof PlaybackProgressItemSchema.static;

export const PlaybackStatusSchema = t.Union([t.Literal("unwatched"), t.Literal("in_progress"), t.Literal("watched")]);

export const PlaybackItemStatusSchema = t.Object({
	status: PlaybackStatusSchema,
	progress: t.Nullable(PlaybackProgressItemSchema),
});

export type PlaybackItemStatusContract = typeof PlaybackItemStatusSchema.static;

export const MetadataPlaybackProgressSchema = t.Composite([
	PlaybackItemStatusSchema,
	t.Object({
		// Per-media-file playback status (watched/in_progress/unwatched + progress)
		// for every file of this title, resolved server-side so clients don't
		// re-derive it from the episodes map.
		fileProgress: t.Record(t.String(), PlaybackItemStatusSchema),
		completedEpisodes: t.Integer({ minimum: 0 }),
		totalEpisodes: t.Integer({ minimum: 0 }),
		episodes: t.Record(t.String(), PlaybackItemStatusSchema),
	}),
]);

export type MetadataPlaybackProgressContract = typeof MetadataPlaybackProgressSchema.static;

export const ContinueWatchingItemSchema = t.Object({
	mediaFileId: t.String(),
	metadata: t.Object({
		id: t.String(),
		title: t.String(),
		type: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
	}),
	backdropId: t.Nullable(t.String()),
	/** Version of the backdrop image — feeds the client's image cache key. */
	backdropUpdatedAt: t.Nullable(t.Date()),
	episode: t.Nullable(
		t.Object({
			title: t.Nullable(t.String()),
			episodeNumber: t.Integer(),
			seasonNumber: t.Integer(),
			absoluteNumber: t.Nullable(t.Integer()),
		}),
	),
	position: t.Number({ minimum: 0 }),
	duration: t.Number({ minimum: 0 }),
	progressPercent: t.Number({ minimum: 0, maximum: 100 }),
	audioStreamIndex: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
	subtitleId: t.Optional(t.Nullable(t.String())),
});

export type ContinueWatchingItem = typeof ContinueWatchingItemSchema.static;

export const ContinueWatchingResponseSchema = t.Object({
	items: t.Array(ContinueWatchingItemSchema),
});

export type ContinueWatchingResponse = typeof ContinueWatchingResponseSchema.static;

export const PlaybackDiagnosticsSchema = t.Object({
	mediaFileId: t.String(),
	source: t.Object({
		container: t.Nullable(t.String()),
		sizeBytes: t.Nullable(t.Number({ minimum: 0 })),
		duration: t.Nullable(t.Number({ minimum: 0 })),
		bitrateKbps: t.Nullable(t.Number({ minimum: 0 })),
		videoCodec: t.Nullable(t.String()),
		videoProfile: t.Nullable(t.String()),
		width: t.Nullable(t.Integer({ minimum: 0 })),
		height: t.Nullable(t.Integer({ minimum: 0 })),
		aspectRatio: t.Nullable(t.String()),
		frameRate: t.Nullable(t.String()),
		pixelFormat: t.Nullable(t.String()),
		audioStreamIndex: t.Nullable(t.Integer({ minimum: 0 })),
		audioCodec: t.Nullable(t.String()),
		audioChannels: t.Nullable(t.Integer({ minimum: 0 })),
		audioChannelLayout: t.Nullable(t.String()),
		audioLanguage: t.Nullable(t.String()),
		audioTitle: t.Nullable(t.String()),
		audioBitrateKbps: t.Nullable(t.Number({ minimum: 0 })),
	}),
	session: t.Nullable(
		t.Object({
			operationId: t.Optional(t.String()),
			mode: PlaybackModeSchema,
			videoTranscode: t.Boolean(),
			audioTranscode: t.Boolean(),
			videoEncoder: t.String(),
			audioEncoder: t.String(),
			targetVideoBitrateKbps: t.Nullable(t.Number({ minimum: 0 })),
			hwaccel: t.String(),
			tonemapped: t.Optional(t.Boolean()),
			toneMapMethod: t.Optional(t.Union([t.Literal("tonemapx"), t.Literal("zscale"), t.Literal("none")])),
			reasons: PlaybackReasonsSchema,
			startTime: t.Number({ minimum: 0 }),
			startedAt: t.String({ format: "date-time" }),
			lastActivityAt: t.String({ format: "date-time" }),
			processId: t.Nullable(t.Integer()),
			processExitCode: t.Nullable(t.Integer()),
			/** ffmpeg encode position/speed from the transcode progress monitor. */
			encodePositionSeconds: t.Nullable(t.Number({ minimum: 0 })),
			encodePercent: t.Nullable(t.Number({ minimum: 0, maximum: 100 })),
			encodeSpeed: t.Nullable(t.String()),
		}),
	),
	buffer: t.Nullable(
		t.Object({
			state: t.Union([t.Literal("pending"), t.Literal("transcoding"), t.Literal("completed")]),
			active: t.Boolean(),
			bufferedSeconds: t.Number({ minimum: 0 }),
			bufferedUntil: t.Number({ minimum: 0 }),
			segments: t.Integer({ minimum: 0 }),
			segmentDuration: t.Number({ exclusiveMinimum: 0 }),
			progressPercent: t.Nullable(t.Number({ minimum: 0, maximum: 100 })),
		}),
	),
});

export type PlaybackDiagnostics = typeof PlaybackDiagnosticsSchema.static;

export const StreamHeartbeatResponseSchema = t.Object({
	status: t.Literal("ok"),
	sessionId: t.String(),
	timestamp: t.String({ format: "date-time" }),
	/** Session entity state — a finished process (EOF) is healthy; only `ended` sessions require a reconnect. */
	state: t.Union([t.Literal("creating"), t.Literal("active"), t.Literal("ending")]),
	/** How many FFmpeg processes have run inside this session (seek/quality restarts included). */
	generation: t.Integer({ minimum: 0 }),
});

export type StreamHeartbeatResponse = typeof StreamHeartbeatResponseSchema.static;

export const SmartPlaySuggestionSchema = t.Object({
	type: t.Union([t.Literal("continue"), t.Literal("next_episode"), t.Literal("new")]),
	mediaFileId: t.String(),
	audioStreamIndex: t.Optional(t.Nullable(t.Integer())),
	subtitleId: t.Optional(t.Nullable(t.String())),
});

export type SmartPlaySuggestion = typeof SmartPlaySuggestionSchema.static;

export const SmartPlayResponseSchema = t.Object({
	suggestion: t.Nullable(SmartPlaySuggestionSchema),
});

export type SmartPlayResponse = typeof SmartPlayResponseSchema.static;
