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
	parse: (raw: string) => T;
	serialize: (val: unknown) => string;
}
