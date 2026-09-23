import type { MetadataType } from "@sdk/common/metadata.types";
import type { SmartPlaySuggestionSchema } from "@sdk/common/stream";
import type { PlaybackDecision } from "@sdk/common/stream.types";
import type { Subprocess } from "bun";
import type { Static } from "elysia";
import type { SessionAccessInfo } from "./runtime/sessions/session-store";

export interface PlaybackSessionInput {
	videoCodecs?: string | undefined;
	audioCodecs?: string | undefined;
	maxBitrate?: number | undefined;
	hdrTransfers?: string | undefined;
	audioStreamIndex?: number | undefined;
	audioLanguage?: string | undefined;
	subtitleLanguage?: string | undefined;
	subtitlesEnabled?: boolean | undefined;
	forcedSubtitlesOnly?: boolean | undefined;
}

export interface MediaFileInfo {
	videoCodec: string | null;
	audioCodec: string | null;
	audioChannels?: number | undefined;
	bitRate?: number | null | undefined;
	formatName?: string | null | undefined;
	durationSeconds?: number | null | undefined;
	sourceFps?: number | null | undefined;
	videoProfile?: string | null | undefined;
	videoPixelFormat?: string | null | undefined;
	/** HDR marker from ffprobe: `smpte2084` (HDR10/PQ) or `arib-std-b67` (HLG). */
	videoColorTransfer?: string | null | undefined;
	/** Dolby Vision profile from the DOVI configuration record. */
	doviProfile?: number | null | undefined;
}

export interface AudioStream {
	index: number;
	language: string | null;
	title?: string | null | undefined;
	isDefault: boolean;
	isCommentary?: boolean | undefined;
	codecName: string;
}

export interface Subtitle {
	id: string;
	language: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired?: boolean | undefined;
	streamIndex: number | null;
	type: "embedded" | "external";
}

export interface PlaybackPreferenceOverrides {
	audioLanguage?: string | undefined;
	subtitleLanguage?: string | undefined;
	subtitlesEnabled?: boolean | undefined;
	forcedSubtitlesOnly?: boolean | undefined;
}

export interface SmartPlay {
	suggestion: SmartPlaySuggestion | null;
}

export type SmartPlaySuggestion = Static<typeof SmartPlaySuggestionSchema>;

export interface ProgressComputeRow {
	mediaFileId: string;
	episodeId?: string | null | undefined;
	position: number;
	completed: boolean;
	audioStreamIndex?: number | null | undefined;
	subtitleId?: string | null | undefined;
	updatedAt?: Date | undefined;
}

export interface PlaybackProgressComputeData {
	metadata: { type: string };
	mediaFiles: Array<{ id: string; movieId: string | null; episodeId: string | null }>;
	progressRows: Array<ProgressComputeRow & { duration?: number | null; updatedAt: Date }>;
	episodes: Array<{ id: string; episodeType?: string | null }>;
}

export interface SmartPlayComputeData {
	metadata: { type: string; numberingMode?: string | null };
	mediaFiles: Array<{ id: string; movieId: string | null; episodeId: string | null; isDefault?: boolean; updatedAt?: Date }>;
	progressRows: ProgressComputeRow[];
	seasons?: Array<{ id: string; seasonNumber: number }> | undefined;
	episodes: Array<{
		id: string;
		seasonId?: string | null;
		episodeNumber?: number;
		absoluteNumber?: number | null;
		episodeType?: string | null;
	}>;
}

export interface ContinueWatchingData {
	progressRows: Array<{
		mediaFileId: string;
		metadataId: string;
		movieId: string | null;
		episodeId: string | null;
		position: number;
		duration: number;
		completed: boolean;
		audioStreamIndex: number | null;
		subtitleId: string | null;
		updatedAt: Date;
	}>;
	metadataList: Array<{ id: string; title: string; type: MetadataType }>;
	mediaFiles: Array<{
		id: string;
		metadataId: string;
		movieId: string | null;
		episodeId: string | null;
		duration: number | null;
		isDefault: boolean;
		updatedAt: Date;
	}>;
	seasons: Array<{ id: string; metadataId: string; seasonNumber: number }>;
	episodes: Array<{
		id: string;
		seasonId: string;
		episodeNumber: number;
		absoluteNumber: number | null;
		title: string | null;
		episodeType: string | null;
	}>;
	backdrops: Array<{ metadataId: string; imageId: string; imageUpdatedAt: Date }>;
}

export interface StreamingLifecycleCallbacks {
	cancelOperation(operationId: string): Promise<unknown>;
	onSessionStarted(session: { sessionId: string; mediaFileId: string; profileId: string }): void;
	onSessionEnded(session: { sessionId: string; mediaFileId: string; profileId: string; reason: string }): void;
}

export interface TerminatedSessionEntry {
	mediaFileId: string;
	profileId: string;
	reason: string;
	terminatedAt: number;
}

export type RequireSession = (sessionId: string, label?: string) => SessionAccessInfo;

/** Result of a release attempt — `unknown` means the session never existed (or its terminated history expired). */
export type SessionReleaseOutcome = "released" | "already-ended" | "unknown";

export interface SeekResult {
	startTime: number;
	reusedBuffer: boolean;
}

export interface HlsBufferedSegment {
	index: number;
	startTime: number;
	endTime: number;
	duration: number;
}

export interface HlsBufferRange {
	startTime: number;
	endTime: number;
	startSegment: number;
	endSegment: number;
	segmentCount: number;
}

export interface HlsBufferAnalysis {
	complete: boolean;
	segments: HlsBufferedSegment[];
	ranges: HlsBufferRange[];
	bufferedSeconds: number;
	bufferedUntil: number;
}

export interface StreamingStrategy {
	startSession(
		sessionId: string,
		inputPath: string,
		outputDir: string,
		decision: PlaybackDecision,
		startTime?: number,
	): Promise<Subprocess>;
}
