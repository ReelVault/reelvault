import type { ProfilePreferenceDefaults } from "@reelvault/sdk/common";
import { systemSettingsStore } from "./system-settings.store";

/** Admin-configurable preference defaults inherited by every profile without sparse overrides. */
export function profileDefaultPreferences(): ProfilePreferenceDefaults {
	return {
		language: systemSettingsStore.get("profiles.defaultPreferences.language"),
		theme: systemSettingsStore.get("profiles.defaultPreferences.theme"),
		autoplay: systemSettingsStore.get("profiles.defaultPreferences.autoplay"),
		autoSkipIntro: systemSettingsStore.get("profiles.defaultPreferences.autoSkipIntro"),
		autoSkipCredits: systemSettingsStore.get("profiles.defaultPreferences.autoSkipCredits"),
		autoSkipRecap: systemSettingsStore.get("profiles.defaultPreferences.autoSkipRecap"),
		audioLanguage: systemSettingsStore.get("profiles.defaultPreferences.audioLanguage") || null,
		subtitleLanguage: systemSettingsStore.get("profiles.defaultPreferences.subtitleLanguage") || null,
		subtitlesEnabled: systemSettingsStore.get("profiles.defaultPreferences.subtitlesEnabled"),
		forcedSubtitlesOnly: systemSettingsStore.get("profiles.defaultPreferences.forcedSubtitlesOnly"),
		autoForcedSubtitles: systemSettingsStore.get("profiles.defaultPreferences.autoForcedSubtitles"),
		preferHearingImpaired: systemSettingsStore.get("profiles.defaultPreferences.preferHearingImpaired"),
		continueWatchingMinutes: systemSettingsStore.get("profiles.defaultPreferences.continueWatchingMinutes"),
		subtitleSize: systemSettingsStore.get("profiles.defaultPreferences.subtitleSize"),
		subtitlePosition: systemSettingsStore.get("profiles.defaultPreferences.subtitlePosition"),
		subtitleColor: systemSettingsStore.get("profiles.defaultPreferences.subtitleColor"),
		subtitleBackground: systemSettingsStore.get("profiles.defaultPreferences.subtitleBackground"),
	};
}
