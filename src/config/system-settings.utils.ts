import type { SettingDefinition, SettingGroup, SettingMeta } from "./system-settings.types";
import { createValueCodecs } from "./value-codecs.utils";

interface SettingBuilder {
	string(key: string, defaultValue: string): SettingDefinition<string>;
	number(key: string, min: number, max: number, defaultValue: number, meta?: SettingMeta): SettingDefinition<number>;
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
			parse: (raw) => stringCodec.parse(raw) ?? (defaultValue === "" ? "" : defaultValue.trim()),
			// A setting whose default is empty must accept "" as a real value (e.g. hwaccelDevice);
			// every other string setting still rejects an empty input.
			validate: (raw) => stringCodec.parse(raw) ?? (defaultValue === "" ? "" : null),
			serialize: (val) => stringCodec.serialize(String(val)),
		}),
		number: (key, min, max, defaultValue, meta = {}) => {
			const codec = codecs.number(min, max);

			return {
				key,
				group,
				type: "number",
				default: defaultValue,
				min,
				max,
				...meta,
				parse: (raw) => codec.parse(raw) ?? defaultValue,
				validate: (raw) => codec.parse(raw),
				serialize: (val) => String(val),
			};
		},
		boolean: (key, defaultValue) => ({
			key,
			group,
			type: "boolean",
			default: defaultValue,
			parse: (raw) => booleanCodec.parse(raw) ?? defaultValue,
			validate: (raw) => booleanCodec.parse(raw),
			serialize: (val) => booleanCodec.serialize(Boolean(val)),
		}),
		stringArray: (key, defaultValue) => ({
			key,
			group,
			type: "string_array",
			default: [...defaultValue],
			parse: (raw) => stringArrayCodec.parse(raw) ?? [...defaultValue],
			validate: (raw) => stringArrayCodec.parse(raw),
			serialize: (val) => JSON.stringify(Array.isArray(val) ? val : []),
		}),
		enum: <T extends string>(key: string, options: T[], defaultValue: T) => {
			const codec = codecs.enum(options);

			return {
				key,
				group,
				type: "enum" as const,
				options: [...options],
				default: defaultValue,
				parse: (raw) => codec.parse(raw) ?? defaultValue,
				validate: (raw) => codec.parse(raw),
				serialize: (val) => String(val),
			};
		},
	};
}
