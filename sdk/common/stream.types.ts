import type {
	ContinueWatchingItem,
	PlaybackDiagnostics,
	PlaybackSessionResponse,
	StreamSeekResponse,
	TranscodeProgressResponse,
} from "@sdk/common/stream";

export type { ContinueWatchingItem, PlaybackDiagnostics, PlaybackSessionResponse, StreamSeekResponse, TranscodeProgressResponse };

export interface TranscodeConfig {
	maxSessions: number;
	inactivityTimeout: number;
	cleanupInterval: number;
	tempRootDir: string;
	hlsSegmentDuration: number;
}

/**
 * direct-stream → FFmpeg remux (-c copy) to HLS. Fast, lossless.
 * transcode     → FFmpeg re-encode (libx264/aac) to HLS. Slow, CPU-heavy.
 *
 * Note: direct-play is intentionally NOT supported. All files are segmented via
 * FFmpeg regardless of size — serving a raw 12GB file over HTTP is not viable.
 */
export type PlaybackMode = "direct-stream" | "transcode";

/**
 * What the client/browser natively supports.
 * Containers are irrelevant — output is always HLS/MPEG-TS.
 */
export interface ClientCapabilities {
	/**
	 * Canonical video codec keys reported by the client.
	 * Values mirror the server's VIDEO_CODEC_MAP (e.g. "h264", "h265", "av1", "vp9", "vp8", "mpeg4").
	 */
	videoCodecs: string[];
	/**
	 * Canonical audio codec keys reported by the client.
	 * Values mirror the server's AUDIO_CODEC_MAP (e.g. "aac", "mp3", "opus", "ac3", "eac3", "flac", "vorbis", "alac").
	 */
	audioCodecs: string[];
	/** Max bitrate in kbps (optional). When set the server caps the video bitrate and forces transcode. */
	maxBitrate?: number | undefined;
	/**
	 * HDR transfer characteristics the client can render WITHOUT tone-mapping,
	 * probed via `MediaCapabilities.decodingInfo` (values: "smpte2084" = HDR10/PQ,
	 * "arib-std-b67" = HLG). Absent or empty = no HDR render path — the server
	 * tone-maps HDR sources to SDR exactly as before.
	 */
	hdrTransfers?: string[] | undefined;
}

/**
 * Conservative fallback used when the client does not report capabilities.
 *
 * Covers every codec supported natively by Chrome 70+, Firefox 75+, Edge 79+,
 * and Safari 11+ without any plug-in. Skews slightly optimistic so that modern
 * content can direct-stream instead of needlessly transcoding when detection
 * data is unavailable (e.g. API clients, scrapers, headless players).
 *
 * Video — H.264 (universal), H.265 (Chromium 107+/Safari 11+),
 *          AV1 (Chrome 70+/Firefox 67+), VP9 (Chrome 29+/Firefox 28+)
 * Audio  — AAC (universal), MP3 (universal), Opus (Chromium 33+/Firefox)
 */
export const DEFAULT_BROWSER_CAPABILITIES: ClientCapabilities = {
	videoCodecs: ["h264", "h265", "av1", "vp9"],
	audioCodecs: ["aac", "mp3", "opus"],
};

export interface PlaybackReasonPart {
	/** Stable machine code — the frontend renders the translated text. */
	code: string;
	params?: Record<string, string | number | boolean | null>;
}

export interface PlaybackReasons {
	video: PlaybackReasonPart;
	audio: PlaybackReasonPart;
}

export interface PlaybackDecision {
	readonly mode: PlaybackMode;
	readonly videoTranscode: boolean;
	readonly audioTranscode: boolean;
	readonly videoCodec?: string | null | undefined;
	/** Requested video bitrate cap in kbps, when the viewer selected a quality preset. */
	readonly videoBitrateKbps?: number | undefined;
	/** Set on the one-shot retry after a hardware encoder failed before the first segment. */
	readonly forceSoftware?: boolean | undefined;
	/** Source is HDR (HDR10/HLG/DV) — the encoder output must be tone-mapped to SDR BT.709. */
	readonly tonemap?: boolean | undefined;
	/** Source HDR stream is remuxed untouched (client declared a matching HDR render path). */
	readonly hdrPassthrough?: boolean | undefined;
	/** Which HDR transfer the source carries, so the filter chain can tag input correctly. */
	readonly tonemapTransfer?: string | null | undefined;
	/** Global FFmpeg stream index of the selected audio track. */
	readonly audioStreamIndex?: number | undefined;
	readonly audioChannels?: number | undefined;
	/** Developer diagnostic string for server logs — never sent to clients. */
	readonly reason: string;
	/** Structured reason codes for API clients (diagnostics, admin live sessions). */
	readonly reasons?: PlaybackReasons | undefined;
	/** ffprobe container format (e.g. "mov,mp4,m4a,3gp,3g2,mj2") — drives probe budgets. */
	readonly formatName?: string | null | undefined;
	/** Source duration in seconds — clamps seek offsets away from EOF. */
	readonly durationSeconds?: number | null | undefined;
	/** Source frame rate — sizes the HLS GOP. */
	readonly sourceFps?: number | null | undefined;
}

/**
 * Lifecycle of a playback session entity. A session spans the whole viewing of
 * a title — seek, quality change and software fallback restart the FFmpeg
 * process inside it without ever leaving the `active` state.
 * - `creating` — registered, waiting for the first FFmpeg process (stream-init).
 * - `active` — has negotiated decision; process may be attached or finished (EOF).
 * - `ending` — release claimed, cleanup in flight; no further process starts.
 */
export type SessionLifecycleState = "creating" | "active" | "ending";

export interface StreamingSession {
	readonly id: string;
	/** Media file selected when this session was created. */
	readonly mediaFileId: string;
	/** Active profile that owns this in-memory session. */
	readonly profileId: string;
	readonly tempDir: string;
	/** Negotiated at session creation; may be updated by the software-fallback restart. */
	decision: PlaybackDecision;
	readonly inputPath: string;
	readonly mode: PlaybackMode;
	operationId?: string | undefined;
	readonly createdAt: number;
	/** Bumped on every FFmpeg process (re)start inside this session. */
	generation: number;
	/** Current FFmpeg process; null before the first start and between restarts. Stays attached after a normal EOF exit. */
	process: Bun.Subprocess | null;
	startTime: number;
	/** Last client contact (heartbeat/playlist/segment/seek) — independent of process liveness. */
	lastActivity: number;
	state: SessionLifecycleState;
	/** Source duration in ms (from ingest), denominator of the encode percent. */
	durationMs: number | null;
	/** Latest ffmpeg stats-line position, updated by the transcode progress monitor. */
	transcodePositionMs: number | null;
	/** Encode position relative to `durationMs`; null when the duration is unknown. */
	transcodePercent: number | null;
	/** ffmpeg-reported encode speed (e.g. "4.2x"). */
	transcodeSpeed: string | null;
}
