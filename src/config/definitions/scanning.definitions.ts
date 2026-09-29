import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("scanning");

export const SCANNING_SETTINGS_DEFINITIONS = {
	"scanning.autoWatcherEnabled": creator.boolean("scanning.autoWatcherEnabled", true),
	"scanning.autoWatcherDelaySeconds": creator.number("scanning.autoWatcherDelaySeconds", 2, 600, 30),
	"scanning.autoWatcherCooldownSeconds": creator.number("scanning.autoWatcherCooldownSeconds", 0, 3600, 120),

	// 0 = auto: derived from measured CPU capacity (see system-resources.service).
	// A static default here would bypass the hardware-adaptive sizing entirely.
	"scanning.concurrency": creator.number("scanning.concurrency", 0, 32, 0),
	"scanning.ffprobeConcurrency": creator.number("scanning.ffprobeConcurrency", 0, 16, 0),

	"ffprobe.path": creator.string("ffprobe.path", "ffprobe"),

	// Video containers the scanner treats as media candidates. Kept as a setting so
	// exotic or uncommon containers can be enabled without a release.
	"scanning.supportedVideoExtensions": creator.stringArray("scanning.supportedVideoExtensions", [
		".mp4",
		".mkv",
		".avi",
		".mov",
		".m4v",
		".webm",
		".wmv",
		".flv",
		".m2ts",
		".mts",
		".vob",
		".ogv",
		".3gp",
		".3g2",
		".f4v",
		".mpeg",
		".mpg",
		".mpe",
		".asf",
		".rm",
		".rmvb",
		".divx",
	]),

	// Wildcard patterns (`*`, `?`) matched against the scan-relative path and the
	// file name — anything matching is skipped before ingest (samples, extras, junk).
	"scanning.ignorePatterns": creator.stringArray("scanning.ignorePatterns", []),
} as const;
