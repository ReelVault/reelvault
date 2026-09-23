import type { MetadataPlaybackProgressContract, PlaybackItemStatusContract, PlaybackProgressItemContract } from "@sdk/common/stream";

export type PlaybackProgressItem = PlaybackProgressItemContract;

export type PlaybackItemStatus = PlaybackItemStatusContract;

export type MetadataPlaybackProgress = MetadataPlaybackProgressContract;

export interface UpdatePlaybackProgress {
	/** Raw playback position — the server normalizes null/undefined/non-finite to 0 and clamps to duration. */
	position?: number | null | undefined;
	audioStreamIndex?: number | null | undefined;
	subtitleId?: string | null | undefined;
	/**
	 * Languages of the tracks the user actually picked (null = cleared / subtitles
	 * off). Stored per title/series so the next episode starts the same way.
	 */
	audioLanguage?: string | null | undefined;
	subtitleLanguage?: string | null | undefined;
}

/** Per-title/series language preferences resolved for a media file. */
export interface StreamPrefs {
	audioLanguage: string | null;
	subtitleLanguage: string | null;
}
