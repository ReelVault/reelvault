/**
 * Declarative plugin configuration.
 *
 * ```ts
 * import { definePlugin, defineConfig, field } from "reelvault-sdk/plugin";
 *
 * export default definePlugin(
 *   defineConfig({
 *     apiKey: field.secret({ label: "API key", required: true, default: "" }),
 *     language: field.string({ label: "Language", default: "en-US" }),
 *   }),
 *   { async setup(host) { host.config.language; } },
 * );
 * ```
 *
 * `defineConfig` derives the admin form descriptors and the runtime parser from
 * the field specs, so authors never hand-write `parse()`/defaults/type guards.
 * A field with a `default` is always present after parsing (and typed as such);
 * a field without one parses to `undefined` when the admin left it empty.
 */
export type PluginConfig = Readonly<Record<string, unknown>>;

export type PluginConfigFieldType = "string" | "number" | "boolean" | "select" | "secret";

export interface PluginConfigFieldOption {
	label: string;
	value: string | number;
}

/** Serialisable descriptor consumed by the admin configuration form. */
export interface PluginConfigField {
	name: string;
	type: PluginConfigFieldType;
	label: string;
	description?: string;
	default?: unknown;
	required?: boolean;
	min?: number;
	max?: number;
	step?: number;
	options?: PluginConfigFieldOption[];
}

interface StringFieldSpec {
	label: string;
	description?: string | undefined;
	required?: boolean | undefined;
	default?: string | undefined;
	pattern?: RegExp | undefined;
	minLength?: number | undefined;
	maxLength?: number | undefined;
}

interface NumberFieldSpec {
	label: string;
	description?: string | undefined;
	required?: boolean | undefined;
	default?: number | undefined;
	min?: number | undefined;
	max?: number | undefined;
	step?: number | undefined;
}

interface BooleanFieldSpec {
	label: string;
	description?: string | undefined;
	required?: boolean | undefined;
	default?: boolean | undefined;
}

interface SelectFieldSpec {
	label: string;
	description?: string | undefined;
	required?: boolean | undefined;
	default?: string | number | undefined;
	options: readonly PluginConfigFieldOption[];
}

/**
 * A field descriptor plus a compile-time marker for its parsed value type.
 * With `const` type parameters, `hasDefault` is reflected into the value type so
 * `host.config` is exact: `field.string({ default: "x" })` → `string`,
 * `field.string({ label: "x" })` → `string | undefined`.
 */
export interface ConfigField<TValue = unknown> {
	readonly type: PluginConfigFieldType;
	readonly label: string;
	readonly description?: string | undefined;
	readonly required?: boolean | undefined;
	readonly default?: unknown;
	readonly pattern?: RegExp | undefined;
	readonly minLength?: number | undefined;
	readonly maxLength?: number | undefined;
	readonly min?: number | undefined;
	readonly max?: number | undefined;
	readonly step?: number | undefined;
	readonly options?: readonly PluginConfigFieldOption[] | undefined;
	/** Compile-time only marker — never assigned at runtime. */
	readonly __value?: TValue;
}

type WithDefault<TSpec, TValue> = TSpec extends { default: TValue } ? TValue : TValue | undefined;

type OptionsValue<TOptions> = TOptions extends ReadonlyArray<{ value: infer TValue }> ? TValue : string | number;

export const field = {
	string<const TSpec extends StringFieldSpec>(spec: TSpec): ConfigField<WithDefault<TSpec, string>> {
		return { type: "string", ...spec };
	},
	secret<const TSpec extends StringFieldSpec>(spec: TSpec): ConfigField<WithDefault<TSpec, string>> {
		return { type: "secret", ...spec };
	},
	number<const TSpec extends NumberFieldSpec>(spec: TSpec): ConfigField<WithDefault<TSpec, number>> {
		return { type: "number", ...spec };
	},
	boolean<const TSpec extends BooleanFieldSpec>(spec: TSpec): ConfigField<WithDefault<TSpec, boolean>> {
		return { type: "boolean", ...spec };
	},
	select<const TSpec extends SelectFieldSpec>(
		spec: TSpec,
	): ConfigField<
		TSpec extends { default: OptionsValue<TSpec["options"]> } ? OptionsValue<TSpec["options"]> : OptionsValue<TSpec["options"]> | undefined
	> {
		return { type: "select", ...spec };
	},
} as const;

export type PluginConfigShape = Record<string, ConfigField>;

export type InferFields<TFields extends PluginConfigShape> = {
	readonly [K in keyof TFields]: TFields[K] extends ConfigField<infer TValue> ? TValue : never;
};

/**
 * Resolves the parsed value type of a config definition — accepts either the
 * `ConfigDefinition` returned by `defineConfig` or a bare field shape.
 */
export type InferConfig<T> =
	T extends ConfigDefinition<infer TFields> ? InferFields<TFields> : T extends PluginConfigShape ? InferFields<T> : never;

export interface ConfigDefinition<TFields extends PluginConfigShape = PluginConfigShape> {
	/** The raw field specs (only the SDK and server read this). */
	readonly fields: TFields;
	/** Serialisable descriptors for the admin configuration form. */
	readonly descriptors: readonly PluginConfigField[];
	/** Normalises stored values, applying defaults and per-type validation. */
	parse(value: unknown): PluginConfig;
}

export function defineConfig<TFields extends PluginConfigShape>(fields: TFields): ConfigDefinition<TFields> {
	const descriptors = Object.entries(fields).map(([name, configField]) => toDescriptor(name, configField));

	return {
		fields,
		descriptors,
		parse: (value) => parseConfig(fields, value),
	};
}

export function isConfigDefinition(value: unknown): value is ConfigDefinition {
	return isRecord(value) && typeof value.parse === "function" && Array.isArray(value.descriptors);
}

function toDescriptor(name: string, configField: ConfigField): PluginConfigField {
	return {
		name,
		type: configField.type,
		label: configField.label,
		...(configField.description !== undefined ? { description: configField.description } : {}),
		...(configField.default !== undefined ? { default: configField.default } : {}),
		...(configField.required !== undefined ? { required: configField.required } : {}),
		...(configField.min !== undefined ? { min: configField.min } : {}),
		...(configField.max !== undefined ? { max: configField.max } : {}),
		...(configField.step !== undefined ? { step: configField.step } : {}),
		...(configField.options !== undefined ? { options: [...configField.options] } : {}),
	};
}

function parseConfig(fields: PluginConfigShape, value: unknown): PluginConfig {
	if (!isRecord(value)) throw new Error("Plugin configuration must be an object");

	const parsed: Record<string, unknown> = {};
	for (const [name, configField] of Object.entries(fields)) {
		parsed[name] = parseField(name, configField, value[name]);
	}

	return parsed;
}

function parseField(name: string, configField: ConfigField, raw: unknown): unknown {
	switch (configField.type) {
		case "string":
		case "secret":
			return parseStringField(name, configField, raw);
		case "number":
			return parseNumberField(name, configField, raw);
		case "boolean":
			return typeof raw === "boolean" ? raw : configField.default;
		case "select": {
			if (raw === undefined || raw === null) return configField.default;

			const allowed = (configField.options ?? []).map((option) => option.value);

			return allowed.some((option) => option === raw) ? raw : configField.default;
		}
		default:
			return configField.default;
	}
}

function parseStringField(name: string, configField: ConfigField, raw: unknown): unknown {
	if (raw === undefined || raw === null) return configField.default;

	if (typeof raw !== "string") return configField.default;

	if (configField.minLength !== undefined && raw.length < configField.minLength) {
		throw new Error(`Plugin configuration '${name}' is shorter than ${configField.minLength} characters`);
	}

	if (configField.maxLength !== undefined && raw.length > configField.maxLength) {
		throw new Error(`Plugin configuration '${name}' is longer than ${configField.maxLength} characters`);
	}

	if (configField.pattern && !configField.pattern.test(raw)) {
		throw new Error(`Plugin configuration '${name}' does not match the expected format`);
	}

	return raw;
}

function parseNumberField(name: string, configField: ConfigField, raw: unknown): unknown {
	if (raw === undefined || raw === null || raw === "") return configField.default;

	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(value)) return configField.default;

	if (configField.min !== undefined && value < configField.min) {
		throw new Error(`Plugin configuration '${name}' must be at least ${configField.min}`);
	}

	if (configField.max !== undefined && value > configField.max) {
		throw new Error(`Plugin configuration '${name}' must be at most ${configField.max}`);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
