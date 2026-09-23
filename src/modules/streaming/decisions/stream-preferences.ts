import { serverConfig } from "@/server.config";
import { normalizeLower } from "@/utils/type.utils";
import type { AudioStream, PlaybackPreferenceOverrides, Subtitle } from "../streaming.types";
import { toIso639_1 } from "./language-codes";

export function selectPreferredAudioStream<T extends AudioStream>(
	streams: readonly T[],
	preferredLanguage?: string | null,
	explicitStreamIndex?: number,
	options?: {
		clientAudioCodecs?: readonly string[] | undefined;
		smartSelectionEnabled?: boolean | undefined;
	},
): T | undefined {
	if (explicitStreamIndex !== undefined) {
		return streams.find((stream) => stream.index === explicitStreamIndex);
	}

	// Commentary tracks are never the desired default — they are only reachable
	// through an explicit index or when every stream is a commentary.
	const withoutCommentary = streams.filter((stream) => !stream.isCommentary);
	const candidates = withoutCommentary.length > 0 ? withoutCommentary : streams;

	const normalizedLanguage = normalizeLanguage(preferredLanguage);
	let baselineCandidate: T | undefined;

	if (normalizedLanguage) {
		baselineCandidate = candidates.find((stream) => normalizeLanguage(stream.language) === normalizedLanguage);
	}

	baselineCandidate ??= selectDefaultOrFirstStream(candidates);

	if (!(baselineCandidate && options?.smartSelectionEnabled && options.clientAudioCodecs?.length)) {
		return baselineCandidate;
	}

	const supportedCodecs = new Set(options.clientAudioCodecs.map((codec) => codec.toLowerCase()));
	const isBaselineSupported = supportedCodecs.has(baselineCandidate.codecName.toLowerCase());

	if (isBaselineSupported) {
		return baselineCandidate;
	}

	// Baseline is not natively supported (e.g. EAC3 / AC3) - look for an equivalent compatible stream (e.g. AAC)
	const normalizedLangByIndex = new Map<number, string | undefined>();
	for (const stream of candidates) normalizedLangByIndex.set(stream.index, normalizeLanguage(stream.language));

	const baselineLang = normalizedLangByIndex.get(baselineCandidate.index);
	const baselineTitle = normalizeLower(baselineCandidate.title ?? "");

	for (const stream of candidates) {
		if (stream.index === baselineCandidate.index) continue;

		if (!supportedCodecs.has(stream.codecName.toLowerCase())) continue;

		const streamLang = normalizedLangByIndex.get(stream.index);
		const streamTitle = normalizeLower(stream.title ?? "");

		// Match by same language or same title (e.g., "Lektor")
		if (baselineLang !== undefined && baselineLang !== "" && baselineLang === streamLang) return stream;

		if (streamLang === undefined) continue;

		if (baselineTitle !== "" && streamTitle !== "" && baselineTitle === streamTitle) return stream;
	}

	return baselineCandidate;
}

export function selectDefaultOrFirstStream<T extends { index: number; isDefault: boolean }>(streams: readonly T[]): T | undefined {
	let firstByIndex: T | undefined;
	for (const stream of streams) {
		if (stream.isDefault) return stream;

		if (!firstByIndex || stream.index < firstByIndex.index) firstByIndex = stream;
	}

	return firstByIndex;
}

export function resolvePlaybackPreferences(
	preferences:
		| {
				audioLanguage: string | null;
				subtitleLanguage: string | null;
				subtitlesEnabled: boolean;
				forcedSubtitlesOnly: boolean;
				autoForcedSubtitles?: boolean | undefined;
				preferHearingImpaired?: boolean | undefined;
		  }
		| null
		| undefined,
	overrides: PlaybackPreferenceOverrides,
	perTitle?: { audioLanguage?: string | null; subtitleLanguage?: string | null } | null,
) {
	const defaults = serverConfig.profiles.defaultPreferences;

	return {
		audioLanguage: overrides.audioLanguage ?? preferences?.audioLanguage ?? perTitle?.audioLanguage ?? defaults.audioLanguage,
		subtitleLanguage:
			overrides.subtitleLanguage ?? preferences?.subtitleLanguage ?? perTitle?.subtitleLanguage ?? defaults.subtitleLanguage,
		subtitlesEnabled: overrides.subtitlesEnabled ?? preferences?.subtitlesEnabled ?? defaults.subtitlesEnabled,
		forcedSubtitlesOnly: overrides.forcedSubtitlesOnly ?? preferences?.forcedSubtitlesOnly ?? defaults.forcedSubtitlesOnly,
		autoForcedSubtitles: preferences?.autoForcedSubtitles ?? defaults.autoForcedSubtitles,
		preferHearingImpaired: preferences?.preferHearingImpaired ?? defaults.preferHearingImpaired,
	};
}

export function selectPreferredSubtitle(
	subtitles: readonly Subtitle[],
	preferences: Pick<
		ReturnType<typeof resolvePlaybackPreferences>,
		"subtitleLanguage" | "subtitlesEnabled" | "forcedSubtitlesOnly" | "autoForcedSubtitles" | "preferHearingImpaired"
	> & {
		audioLanguage?: string | null | undefined;
	},
): Subtitle | undefined {
	if (!preferences.subtitlesEnabled) return undefined;

	const normalizedLangById = new Map<string, string | undefined>();
	for (const sub of subtitles) normalizedLangById.set(sub.id, normalizeLanguage(sub.language));

	const preferredLanguage = normalizeLanguage(preferences.subtitleLanguage ?? preferences.audioLanguage);
	const audioLanguage = normalizeLanguage(preferences.audioLanguage);

	// Watching in the preferred language: only forced subtitles (for foreign-dialogue
	// segments) belong here — full subtitles in the audio's own language do not.
	if (preferredLanguage !== undefined && preferredLanguage === audioLanguage) {
		if (!preferences.autoForcedSubtitles) return undefined;

		return subtitles.find((subtitle) => subtitle.isForced && normalizedLangById.get(subtitle.id) === preferredLanguage);
	}

	if (preferredLanguage === undefined) return undefined;

	const matchingLanguage = subtitles.filter((subtitle) => normalizedLangById.get(subtitle.id) === preferredLanguage);
	const fullSubtitles = matchingLanguage.filter((subtitle) => !subtitle.isForced);

	if (preferences.forcedSubtitlesOnly) {
		return matchingLanguage.find((subtitle) => subtitle.isForced);
	}

	if (preferences.preferHearingImpaired) {
		const sdhSubtitle = fullSubtitles.find((subtitle) => subtitle.isHearingImpaired);

		if (sdhSubtitle) return sdhSubtitle;
	}

	return fullSubtitles[0] ?? matchingLanguage.find((subtitle) => subtitle.isForced);
}

function normalizeLanguage(language?: string | null): string | undefined {
	if (!language) return undefined;

	const normalized = normalizeLower(language);

	return normalized === "" ? undefined : toIso639_1(normalized);
}
