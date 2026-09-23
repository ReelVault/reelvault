import type { ClientCapabilities, PlaybackDecision } from "@reelvault/sdk/common";
import type { AudioStream, MediaFileInfo, PlaybackSessionInput, Subtitle } from "../streaming.types";
import { decidePlaybackMode } from "./playback-decision";
import {
	resolvePlaybackPreferences,
	selectDefaultOrFirstStream,
	selectPreferredAudioStream,
	selectPreferredSubtitle,
} from "./stream-preferences";

export interface SessionSelectionInput {
	file: {
		duration: number | null;
		bitRate?: number | null | undefined;
		formatName?: string | null | undefined;
		videoStreams: ReadonlyArray<{
			index: number;
			isDefault: boolean;
			codecName: string | null;
			profile?: string | null | undefined;
			pixelFormat?: string | null | undefined;
			frameRate?: string | null | undefined;
			colorTransfer?: string | null | undefined;
			doviProfile?: number | null | undefined;
		}>;
		audioStreams: ReadonlyArray<AudioStream & { channels?: number }>;
		subtitles: readonly Subtitle[];
	};
	preferences:
		| {
				audioLanguage: string | null;
				subtitleLanguage: string | null;
				subtitlesEnabled: boolean;
				forcedSubtitlesOnly: boolean;
				autoForcedSubtitles?: boolean | undefined;
				preferHearingImpaired?: boolean | undefined;
				continueWatchingMinutes?: number;
		  }
		| null
		| undefined;
	/** Per-title languages persisted in profile_stream_prefs — between profile prefs and request overrides. */
	perTitlePreferences?: { audioLanguage?: string | null; subtitleLanguage?: string | null } | null;
	capabilitiesQuery: PlaybackSessionInput;
	capabilities: ClientCapabilities;
	smartSelectionEnabled: boolean;
	/** Remembered audio track of this file's progress — only honoured while the progress is active. */
	savedAudioStreamIndex?: number | null | undefined;
	/** Per-title preference persisted in playback progress: string = subtitle id, null = subtitles off, undefined = no saved choice. */
	savedSubtitleId?: string | null | undefined;
	/** The file's progress qualifies as "continue watching" (past the profile threshold, not completed). */
	hasActiveProgress?: boolean;
	/** Any file of this title/series has active progress — unlocks per-title remembered languages. */
	hasActiveTitleProgress?: boolean;
}

export interface PlaybackSelection {
	videoCodec: string | null;
	audioStream: (AudioStream & { channels?: number }) | undefined;
	subtitle: Subtitle | undefined;
	decision: PlaybackDecision;
	playbackPreferences: ReturnType<typeof resolvePlaybackPreferences>;
}

export function resolveSessionSelection(input: SessionSelectionInput): PlaybackSelection {
	const { file, preferences, capabilitiesQuery, capabilities, smartSelectionEnabled } = input;

	const playbackPreferences = resolvePlaybackPreferences(preferences, capabilitiesQuery, input.perTitlePreferences);
	const videoStream = selectDefaultOrFirstStream(file.videoStreams);
	const videoCodec = videoStream?.codecName ?? null;
	const audioStream = selectPreferredAudioStream(file.audioStreams, playbackPreferences.audioLanguage, capabilitiesQuery.audioStreamIndex, {
		clientAudioCodecs: capabilities.audioCodecs,
		smartSelectionEnabled,
	});
	// A title with active progress reopens on its remembered audio track; the
	// explicit request index (manual in-session switch) still wins above it.
	const resumeAudioStream =
		capabilitiesQuery.audioStreamIndex === undefined && input.hasActiveProgress && input.savedAudioStreamIndex != null
			? file.audioStreams.find((stream) => stream.index === input.savedAudioStreamIndex)
			: undefined;
	const effectiveAudioStream = resumeAudioStream ?? audioStream;
	const subtitleSelection = selectPreferredSubtitle(file.subtitles, {
		...playbackPreferences,
		audioLanguage: effectiveAudioStream?.language ?? null,
	});
	// A saved per-title choice beats the global default, but only while the title
	// is in "continue watching": null means the user turned subtitles off for this
	// title, an id pins that exact subtitle.
	let subtitle = subtitleSelection;
	let effectivePreferences = playbackPreferences;
	const savedSubtitleId = input.hasActiveProgress ? input.savedSubtitleId : undefined;
	if (savedSubtitleId === null) {
		effectivePreferences = { ...playbackPreferences, subtitlesEnabled: false };
		subtitle = undefined;
	} else if (typeof savedSubtitleId === "string") {
		const saved = file.subtitles.find((s) => s.id === savedSubtitleId);
		if (saved) {
			effectivePreferences = { ...playbackPreferences, subtitlesEnabled: true };
			subtitle = saved;
		}
	}

	const decisionInfo: MediaFileInfo = {
		videoCodec,
		audioCodec: audioStream?.codecName ?? null,
		audioChannels: audioStream?.channels,
		bitRate: file.bitRate,
		videoProfile: videoStream?.profile ?? null,
		videoPixelFormat: videoStream?.pixelFormat ?? null,
		videoColorTransfer: videoStream?.colorTransfer ?? null,
		doviProfile: videoStream?.doviProfile ?? null,
		formatName: file.formatName,
		durationSeconds: file.duration,
		sourceFps: videoStream?.frameRate ? Number(videoStream.frameRate) : null,
	};
	const decision = decidePlaybackMode(decisionInfo, capabilities, effectiveAudioStream?.index);

	return { videoCodec, audioStream: effectiveAudioStream, subtitle, decision, playbackPreferences: effectivePreferences };
}
