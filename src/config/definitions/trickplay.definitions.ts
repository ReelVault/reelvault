import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("trickplay");

export const TRICKPLAY_SETTINGS_DEFINITIONS = {
	"trickplay.enabled": creator.boolean("trickplay.enabled", true),
	"trickplay.autoOnRefresh": creator.boolean("trickplay.autoOnRefresh", true),
	"trickplay.intervalSeconds": creator.number("trickplay.intervalSeconds", 2, 60, 10),
	"trickplay.tileWidth": creator.number("trickplay.tileWidth", 160, 640, 320),
	"trickplay.columns": creator.number("trickplay.columns", 2, 10, 5),

	// 0 = automatic: 5% of the artifacts volume capacity clamped to 5–100 GB.
	// Caps every core-generated artifact (trickplay sprites and VTT today) —
	// plugins keep their own fixed quota in server.constants.
	"system.artifacts.coreMaxStorageGb": creator.number("system.artifacts.coreMaxStorageGb", 0, 100_000, 0),
} as const;
