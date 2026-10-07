export type SettingGroup =
	| "streaming"
	| "scanning"
	| "markers"
	| "downloads"
	| "trickplay"
	| "images"
	| "workers"
	| "playback_defaults"
	| "resources"
	| "system"
	| "network";

export type CpuProfile = "conservative" | "balanced" | "performance" | "custom";

type SettingType = "string" | "number" | "boolean" | "enum" | "string_array";

export interface SettingDefinition<T = unknown> {
	key: string;
	group: SettingGroup;
	type: SettingType;
	default: T;
	options?: string[]; // for enum
	/**
	 * Lenient decode of a stored/legacy value — falls back to `default` so boot
	 * never fails on a corrupt row. Update paths must use `validate` instead.
	 */
	parse: (raw: string) => T;
	/** Strict validation of a client-supplied value; `null` means invalid. */
	validate: (raw: string) => T | null;
	serialize: (val: unknown) => string;
}
