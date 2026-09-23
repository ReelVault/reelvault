import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("markers");

/**
 * Chapter-title keywords for automatic intro/credits/recap markers, matched
 * against the FIRST word of a named chapter (case- and diacritics-insensitive).
 * English defaults on purpose — the server ships no language-specific word
 * lists; extend these in the admin panel with your language's terms.
 */
export const MARKERS_SETTINGS_DEFINITIONS = {
	"markers.introKeywords": creator.stringArray("markers.introKeywords", ["intro", "opening", "op"]),
	"markers.creditsKeywords": creator.stringArray("markers.creditsKeywords", ["credits", "credit", "ending", "outro"]),
	"markers.recapKeywords": creator.stringArray("markers.recapKeywords", ["recap", "previously"]),
} as const;
