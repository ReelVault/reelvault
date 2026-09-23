import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("trickplay");

export const TRICKPLAY_SETTINGS_DEFINITIONS = {
	"trickplay.enabled": creator.boolean("trickplay.enabled", true),
	"trickplay.autoOnRefresh": creator.boolean("trickplay.autoOnRefresh", true),
	"trickplay.intervalSeconds": creator.number("trickplay.intervalSeconds", 2, 60, 10),
	"trickplay.tileWidth": creator.number("trickplay.tileWidth", 160, 640, 320),
	"trickplay.columns": creator.number("trickplay.columns", 2, 10, 5),
} as const;
