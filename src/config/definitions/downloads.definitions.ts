import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("downloads");

/** Storage quota per profile in bytes; 0 disables the quota. Retention 0 = keep forever. */
export const DOWNLOADS_SETTINGS_DEFINITIONS = {
	"downloads.enabled": creator.boolean("downloads.enabled", true),
	"downloads.maxStorageBytesPerProfile": creator.number("downloads.maxStorageBytesPerProfile", 0, Number.MAX_SAFE_INTEGER, 21_474_836_480),
	"downloads.retentionDays": creator.number("downloads.retentionDays", 0, 365, 0),
} as const;
