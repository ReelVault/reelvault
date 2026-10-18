import type { PluginConfigField } from "@reelvault/sdk/plugin";

const CAPITALIZE_FIRST_REGEX = /^./;
const CAMEL_CASE_SPLIT_REGEX = /([A-Z])/g;
const SECRET_KEYWORDS = ["key", "secret", "token", "password"];

/** Unset, null or whitespace-only — a required field holding any of these has not been filled in. */
export function isBlankConfigValue(value: unknown): boolean {
	return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export function withoutKeys(config: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
	const copy = { ...config };
	for (const key of keys) {
		Reflect.deleteProperty(copy, key);
	}

	return copy;
}

/** A secret is never returned, so its field only says whether a non-blank value is stored. */
export function markSecretPresence(fields: readonly PluginConfigField[], config: Record<string, unknown>): PluginConfigField[] {
	return fields.map((field) => (field.type === "secret" ? { ...field, hasValue: !isBlankConfigValue(config[field.name]) } : field));
}

/**
 * Omits secret fields from the config returned to clients. Omitting (not
 * masking) keeps `savePluginConfig`'s merge semantics intact — a key that is
 * absent from the payload is left unchanged on disk.
 */
export function redactSecretValues(config: Record<string, unknown>, fields: readonly PluginConfigField[]): Record<string, unknown> {
	const secretKeys = new Set<string>();
	for (const field of fields) {
		if (field.type === "secret") secretKeys.add(field.name);
	}

	if (secretKeys.size === 0) return config;

	const redacted: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (!secretKeys.has(key)) redacted[key] = value;
	}

	return redacted;
}

/** Field descriptors for a plugin that declares none: one field per stored key, typed by its value. */
export function inferFieldsFromConfig(config: Record<string, unknown>): PluginConfigField[] {
	return Object.entries(config).map(([key, value]) => {
		const label = key
			.replaceAll(CAMEL_CASE_SPLIT_REGEX, " $1")
			.replace(CAPITALIZE_FIRST_REGEX, (str) => str.toUpperCase())
			.trim();
		if (typeof value === "boolean") {
			return { name: key, type: "boolean", label, default: value };
		}

		if (typeof value === "number") {
			return { name: key, type: "number", label, default: value };
		}

		if (typeof value === "string") {
			const keyLower = key.toLowerCase();
			const isSecret = SECRET_KEYWORDS.some((kw) => keyLower.includes(kw));
			// Never echo a secret value back as a field default: `fields` is
			// returned unredacted (unlike `config`), so a plain `default: value`
			// would leak the stored API key/token to the client.
			if (isSecret) return { name: key, type: "secret", label };

			return { name: key, type: "string", label, default: value };
		}

		return { name: key, type: "string", label, default: JSON.stringify(value) };
	});
}
