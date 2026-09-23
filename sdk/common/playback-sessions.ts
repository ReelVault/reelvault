import { t } from "elysia";
import { PlaybackModeSchema, PlaybackReasonsSchema } from "./stream";

// Optional fields accept null as well as undefined — the server normalizes
// null to "absent" so clients can pass their raw state without pre-validation.
export const CreatePlaybackSessionSchema = t.Object(
	{
		mediaFileId: t.String({ minLength: 1 }),
		videoCodecs: t.Optional(t.Nullable(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }))),
		audioCodecs: t.Optional(t.Nullable(t.Array(t.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }))),
		maxBitrate: t.Optional(t.Nullable(t.Number({ minimum: 250, maximum: 20_000 }))),
		hdrTransfers: t.Optional(t.Nullable(t.Array(t.String({ minLength: 4, maxLength: 16 }), { maxItems: 8 }))),
		audioStreamIndex: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
		audioLanguage: t.Optional(t.Nullable(t.String({ minLength: 2, maxLength: 16 }))),
		subtitleLanguage: t.Optional(t.Nullable(t.String({ minLength: 2, maxLength: 16 }))),
		subtitlesEnabled: t.Optional(t.Nullable(t.Boolean())),
		forcedSubtitlesOnly: t.Optional(t.Nullable(t.Boolean())),
	},
	{ additionalProperties: false },
);

export type CreatePlaybackSession = typeof CreatePlaybackSessionSchema.static;

export const PlaybackSessionSchema = t.Object({
	operationId: t.String(),
	mode: PlaybackModeSchema,
	sessionId: t.String(),
	reasons: PlaybackReasonsSchema,
	audioStreamIndex: t.Nullable(t.Integer({ minimum: 0 })),
	subtitleLanguage: t.Nullable(t.String()),
	subtitlesEnabled: t.Boolean(),
	forcedSubtitlesOnly: t.Boolean(),
	subtitleId: t.Nullable(t.String()),
	subtitleStreamIndex: t.Nullable(t.Integer({ minimum: 0 })),
	subtitleType: t.Nullable(t.Union([t.Literal("embedded"), t.Literal("external")])),
});

export type PlaybackSession = typeof PlaybackSessionSchema.static;

/** Active playback session of the calling profile — the remote-control page's row. */
export const PlaybackSessionSummarySchema = t.Object({
	sessionId: t.String(),
	mediaFileId: t.String(),
	title: t.Nullable(t.String()),
	type: t.Nullable(t.String()),
	posterImageId: t.Nullable(t.String()),
	/** Version of the poster image — feeds the client's image cache key. */
	posterImageUpdatedAt: t.Nullable(t.Date()),
	mode: PlaybackModeSchema,
	state: t.String(),
	startedAt: t.Number({ minimum: 0 }),
	lastActivity: t.Number({ minimum: 0 }),
});

export type PlaybackSessionSummary = typeof PlaybackSessionSummarySchema.static;

export const MyPlaybackSessionsResponseSchema = t.Object({
	sessions: t.Array(PlaybackSessionSummarySchema),
});

export type MyPlaybackSessionsResponse = typeof MyPlaybackSessionsResponseSchema.static;

export const IdempotencyKeyHeadersSchema = t.Object({
	"idempotency-key": t.String({ minLength: 1, maxLength: 255 }),
});
