import { t } from "elysia";

export const PlaybackCommandTypeSchema = t.Union([
	t.Literal("play"),
	t.Literal("pause"),
	t.Literal("seek"),
	t.Literal("stop"),
	t.Literal("setVolume"),
]);

export type PlaybackCommandType = typeof PlaybackCommandTypeSchema.static;

export const PlaybackCommandSchema = t.Object({
	type: PlaybackCommandTypeSchema,
	position: t.Optional(t.Number({ minimum: 0 })),
	/** Relative seek offset in seconds (e.g. -10 or +10). */
	relative: t.Optional(t.Number()),
	/** Only for `setVolume` — target loudness in the 0..1 range. */
	volume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
});

export type PlaybackCommand = typeof PlaybackCommandSchema.static;

export const PlaybackCommandResponseSchema = t.Object({
	delivered: t.Boolean(),
	command: PlaybackCommandTypeSchema,
	position: t.Optional(t.Number()),
	relative: t.Optional(t.Number()),
	volume: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
});

export type PlaybackCommandResponse = typeof PlaybackCommandResponseSchema.static;

export interface RealtimeEventMessage<TData = unknown> {
	type: string;
	payload: TData;
	occurredAt: string;
}

export interface PlaybackSessionProgressEvent {
	sessionId: string;
	position?: number | undefined;
	duration?: number | undefined;
	isPaused?: boolean | undefined;
}

export interface RealtimeEventMap {
	"notification:created": {
		id?: string | undefined;
		userId?: string | undefined;
		profileId?: string | null | undefined;
		title?: string | undefined;
		message?: string | null | undefined;
		type?: string | undefined;
		read?: boolean | undefined;
		createdAt?: string | undefined;
		data?: unknown;
		[key: string]: unknown;
	};
	"worker:job:completed": {
		jobId: string;
		workerId: string;
		type: string;
		[key: string]: unknown;
	};
	"plugin:enabled": {
		pluginId?: string | undefined;
		[key: string]: unknown;
	};
	"plugin:disabled": {
		pluginId?: string | undefined;
		[key: string]: unknown;
	};
	"library:scan:completed": {
		libraryId?: string | undefined;
		libraryTitle?: string | undefined;
		[key: string]: unknown;
	};
	"playback:session:started": {
		sessionId: string;
		mediaFileId: string;
	};
	"playback:session:ended": {
		sessionId: string;
		mediaFileId: string;
		reason?: string | undefined;
	};
	"playback:session:seeked": {
		sessionId: string;
		startTime: number;
		position?: number | undefined;
	};
	"playback:session:progress": PlaybackSessionProgressEvent;
	"playback:session:terminated": {
		sessionId: string;
		mediaFileId?: string | undefined;
		reason?: string | undefined;
	};
	"playback:command": {
		sessionId: string;
		command: PlaybackCommand;
		senderProfileId?: string | undefined;
	};
	"playback:progress:updated": {
		mediaFileId: string;
		position: number;
		duration: number;
		completed: boolean;
		audioStreamIndex?: number | null | undefined;
		subtitleId?: string | null | undefined;
	};
	"auth:session:revoked": {
		sessionId: string;
		userId?: string | undefined;
	};
	"system.resource_alert": unknown;
	"system.rescue_state": unknown;
}

export type RealtimeEventName = keyof RealtimeEventMap | (string & {});

export type RealtimePayload<E extends string> = E extends keyof RealtimeEventMap ? RealtimeEventMap[E] : unknown;
