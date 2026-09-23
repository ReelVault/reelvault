import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";

export function assertStorageKey(key: string): void {
	if (!PLUGIN_IDENTIFIER_PATTERN.test(key) || key.length > serverConfig.plugins.storage.maxKeyLength) {
		throw new ValidationError(
			`Plugin storage key must match [A-Za-z0-9._-] and be at most ${serverConfig.plugins.storage.maxKeyLength} characters`,
			{ code: "plugin.storage.invalid_key" },
		);
	}
}

/**
 * `JSON.stringify` is typed as returning `string`, but at runtime it returns
 * `undefined` for `undefined`/function/symbol inputs. This wrapper widens the
 * type so the `undefined` guard below is a real check (not an "impossible
 * condition" to the type-aware linter).
 */
function stringifyOrUndefined(value: unknown): string | undefined {
	return JSON.stringify(value);
}

export function serializeStorageValue(value: unknown): string {
	let serialized: string | undefined;
	try {
		serialized = stringifyOrUndefined(value);
	} catch {
		throw new ValidationError("Plugin storage value must be JSON-serializable", { code: "plugin.storage.invalid_value" });
	}

	if (serialized === undefined)
		throw new ValidationError("Plugin storage value must be JSON-serializable", { code: "plugin.storage.invalid_value" });

	if (new TextEncoder().encode(serialized).byteLength > serverConfig.plugins.storage.maxValueBytes) {
		throw new ValidationError(`Plugin storage value must not exceed ${serverConfig.plugins.storage.maxValueBytes} bytes`, {
			code: "plugin.storage.value_too_large",
		});
	}

	return serialized;
}
