import {
	PROFILE_THEME_OPTIONS,
	SUBTITLE_BACKGROUND_OPTIONS,
	SUBTITLE_COLOR_OPTIONS,
	SUBTITLE_POSITION_OPTIONS,
	SUBTITLE_SIZE_OPTIONS,
} from "../profile-preferences.definitions";
import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("playback_defaults");
// Administrative quota — belongs with the other system-level knobs, not the
// per-profile playback defaults.
const systemCreator = SystemSettingsCreator("system");

export const PROFILES_SETTINGS_DEFINITIONS = {
	// 0 = no limit (default keeps unattended instances from unbounded profile growth).
	"profiles.maxProfilesPerUser": systemCreator.number("profiles.maxProfilesPerUser", 0, 100, 20),
	"profiles.defaultPreferences.language": creator.string("profiles.defaultPreferences.language", "en"),
	"profiles.defaultPreferences.theme": creator.enum("profiles.defaultPreferences.theme", [...PROFILE_THEME_OPTIONS], "system"),
	"profiles.defaultPreferences.autoplay": creator.boolean("profiles.defaultPreferences.autoplay", false),
	"profiles.defaultPreferences.autoSkipIntro": creator.boolean("profiles.defaultPreferences.autoSkipIntro", false),
	"profiles.defaultPreferences.autoSkipCredits": creator.boolean("profiles.defaultPreferences.autoSkipCredits", false),
	"profiles.defaultPreferences.autoSkipRecap": creator.boolean("profiles.defaultPreferences.autoSkipRecap", false),
	"profiles.defaultPreferences.audioLanguage": creator.string("profiles.defaultPreferences.audioLanguage", ""),
	"profiles.defaultPreferences.subtitleLanguage": creator.string("profiles.defaultPreferences.subtitleLanguage", ""),
	"profiles.defaultPreferences.subtitlesEnabled": creator.boolean("profiles.defaultPreferences.subtitlesEnabled", true),
	"profiles.defaultPreferences.forcedSubtitlesOnly": creator.boolean("profiles.defaultPreferences.forcedSubtitlesOnly", false),
	"profiles.defaultPreferences.autoForcedSubtitles": creator.boolean("profiles.defaultPreferences.autoForcedSubtitles", true),
	"profiles.defaultPreferences.preferHearingImpaired": creator.boolean("profiles.defaultPreferences.preferHearingImpaired", false),
	"profiles.defaultPreferences.continueWatchingMinutes": creator.number("profiles.defaultPreferences.continueWatchingMinutes", 0, 240, 2),
	"profiles.defaultPreferences.subtitleSize": creator.enum(
		"profiles.defaultPreferences.subtitleSize",
		[...SUBTITLE_SIZE_OPTIONS],
		"normal",
	),
	"profiles.defaultPreferences.subtitlePosition": creator.enum(
		"profiles.defaultPreferences.subtitlePosition",
		[...SUBTITLE_POSITION_OPTIONS],
		"bottom",
	),
	"profiles.defaultPreferences.subtitleColor": creator.enum(
		"profiles.defaultPreferences.subtitleColor",
		[...SUBTITLE_COLOR_OPTIONS],
		"white",
	),
	"profiles.defaultPreferences.subtitleBackground": creator.enum(
		"profiles.defaultPreferences.subtitleBackground",
		[...SUBTITLE_BACKGROUND_OPTIONS],
		"semi",
	),
} as const;
