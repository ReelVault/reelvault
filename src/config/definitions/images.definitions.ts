import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("images");

export const IMAGES_SETTINGS_DEFINITIONS = {
	"images.defaultQuality": creator.number("images.defaultQuality", 10, 100, 60),
	"images.defaultWidth": creator.number("images.defaultWidth", 100, 3840, 828),
	"images.maxWidth": creator.number("images.maxWidth", 500, 7680, 1920),
	"images.maxHeight": creator.number("images.maxHeight", 500, 7680, 1920),
	"images.maxUploadBytes": creator.number("images.maxUploadBytes", 1_048_576, Number.MAX_SAFE_INTEGER, 20_971_520),
} as const;
