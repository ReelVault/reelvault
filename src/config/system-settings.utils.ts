import type { SettingDefinition, SettingGroup } from "./system-settings.types";
import { createValueCodecs } from "./value-codecs";

interface SettingBuilder {
	string(key: string, defaultValue: string): SettingDefinition<string>;
	number(key: string, min: number, max: number, defaultValue: number): SettingDefinition<number>;
	boolean(key: string, defaultValue: boolean): SettingDefinition<boolean>;
	stringArray(key: string, defaultValue: readonly string[]): SettingDefinition<string[]>;
	enum<T extends string>(key: string, options: T[], defaultValue: T): SettingDefinition<T>;
}

const codecs = createValueCodecs();
const stringCodec = codecs.string();
const booleanCodec = codecs.boolean();
const stringArrayCodec = codecs.stringArray();

export function SystemSettingsCreator(group: SettingGroup): SettingBuilder {
	return {
		string: (key, defaultValue) => ({
			key,
			group,
			type: "string",
			default: defaultValue,
			parse: (raw) => stringCodec.parse(raw) ?? defaultValue.trim(),
			serialize: (val) => stringCodec.serialize(String(val)),
		}),
		number: (key, min, max, defaultValue) => ({
			key,
			group,
			type: "number",
			default: defaultValue,
			parse: (raw) => codecs.number(min, max).parse(raw) ?? defaultValue,
			serialize: (val) => String(val),
		}),
		boolean: (key, defaultValue) => ({
			key,
			group,
			type: "boolean",
			default: defaultValue,
			parse: (raw) => booleanCodec.parse(raw) ?? defaultValue,
			serialize: (val) => booleanCodec.serialize(Boolean(val)),
		}),
		stringArray: (key, defaultValue) => ({
			key,
			group,
			type: "string_array",
			default: [...defaultValue],
			parse: (raw) => stringArrayCodec.parse(raw) ?? [...defaultValue],
			serialize: (val) => JSON.stringify(Array.isArray(val) ? val : []),
		}),
		enum: <T extends string>(key: string, options: T[], defaultValue: T) => ({
			key,
			group,
			type: "enum" as const,
			options: [...options],
			default: defaultValue,
			parse: (raw) => codecs.enum(options).parse(raw) ?? defaultValue,
			serialize: (val) => String(val),
		}),
	};
}
