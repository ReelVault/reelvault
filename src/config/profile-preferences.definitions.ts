import { createValueCodecs } from "./value-codecs";

export const PROFILE_THEME_OPTIONS = ["system", "light", "dark"] as const;

export const SUBTITLE_SIZE_OPTIONS = ["small", "normal", "large", "extra-large"] as const;

export const SUBTITLE_POSITION_OPTIONS = ["bottom", "top", "middle"] as const;

export const SUBTITLE_COLOR_OPTIONS = ["white", "yellow", "cyan", "green"] as const;

export const SUBTITLE_BACKGROUND_OPTIONS = ["none", "semi", "solid"] as const;

const codecs = createValueCodecs();
const booleanCodec = codecs.boolean();

export const PROFILE_PREFERENCE_DEFINITIONS = {
	language: codecs.string(),
	theme: codecs.enum(PROFILE_THEME_OPTIONS),
	autoplay: booleanCodec,
	autoSkipIntro: booleanCodec,
	autoSkipCredits: booleanCodec,
	autoSkipRecap: booleanCodec,
	audioLanguage: codecs.nullableString(),
	subtitleLanguage: codecs.nullableString(),
	subtitlesEnabled: booleanCodec,
	forcedSubtitlesOnly: booleanCodec,
	autoForcedSubtitles: booleanCodec,
	preferHearingImpaired: booleanCodec,
	continueWatchingMinutes: codecs.number(0, 240),
	subtitleSize: codecs.enum(SUBTITLE_SIZE_OPTIONS),
	subtitlePosition: codecs.enum(SUBTITLE_POSITION_OPTIONS),
	subtitleColor: codecs.enum(SUBTITLE_COLOR_OPTIONS),
	subtitleBackground: codecs.enum(SUBTITLE_BACKGROUND_OPTIONS),
} as const;

export type ProfilePreferenceKey = keyof typeof PROFILE_PREFERENCE_DEFINITIONS;

export type ProfilePreferenceFieldValue = string | number | boolean | null;

/** Field-agnostic codec view — parse results stay per-field, serialize accepts any field value. */
export interface ProfilePreferenceDefinition {
	parse(raw: string): ProfilePreferenceFieldValue | null;
	serialize(value: ProfilePreferenceFieldValue): string;
}

export function isProfilePreferenceKey(key: string): key is ProfilePreferenceKey {
	return Object.hasOwn(PROFILE_PREFERENCE_DEFINITIONS, key);
}
