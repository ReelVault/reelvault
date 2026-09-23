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
} as const;
