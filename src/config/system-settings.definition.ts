import { DOWNLOADS_SETTINGS_DEFINITIONS } from "./definitions/downloads.definitions";
import { IMAGES_SETTINGS_DEFINITIONS } from "./definitions/images.definitions";
import { MARKERS_SETTINGS_DEFINITIONS } from "./definitions/markers.definitions";
import { NETWORK_SETTINGS_DEFINITIONS } from "./definitions/network.definitions";
import { PATHS_SETTINGS_DEFINITIONS } from "./definitions/paths.definitions";
import { PROFILES_SETTINGS_DEFINITIONS } from "./definitions/profiles.definitions";
import { RESOURCES_SETTINGS_DEFINITIONS } from "./definitions/resources.definitions";
import { SCANNING_SETTINGS_DEFINITIONS } from "./definitions/scanning.definitions";
import { STREAMING_SETTINGS_DEFINITIONS } from "./definitions/streaming.definitions";
import { SYSTEM_SETTINGS_DEFINITIONS } from "./definitions/system.definitions";
import { TRICKPLAY_SETTINGS_DEFINITIONS } from "./definitions/trickplay.definitions";
import { WORKERS_SETTINGS_DEFINITIONS } from "./definitions/workers.definitions";

export const SYSTEM_SETTINGS = {
	...DOWNLOADS_SETTINGS_DEFINITIONS,
	...IMAGES_SETTINGS_DEFINITIONS,
	...MARKERS_SETTINGS_DEFINITIONS,
	...NETWORK_SETTINGS_DEFINITIONS,
	...PATHS_SETTINGS_DEFINITIONS,
	...PROFILES_SETTINGS_DEFINITIONS,
	...RESOURCES_SETTINGS_DEFINITIONS,
	...SCANNING_SETTINGS_DEFINITIONS,
	...STREAMING_SETTINGS_DEFINITIONS,
	...SYSTEM_SETTINGS_DEFINITIONS,
	...TRICKPLAY_SETTINGS_DEFINITIONS,
	...WORKERS_SETTINGS_DEFINITIONS,
} as const;

export type SystemSettingKey = keyof typeof SYSTEM_SETTINGS;

export type SystemSettingValue<K extends SystemSettingKey> = (typeof SYSTEM_SETTINGS)[K]["default"];

export function isSystemSettingKey(key: string): key is SystemSettingKey {
	return Object.hasOwn(SYSTEM_SETTINGS, key);
}

export const SETTING_KEYS: readonly SystemSettingKey[] = Object.keys(SYSTEM_SETTINGS).filter((key): key is SystemSettingKey =>
	isSystemSettingKey(key),
);
