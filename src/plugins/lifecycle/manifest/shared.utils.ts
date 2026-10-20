import { DomainError } from "@/utils/domain.errors";
import { isAbsolutePath, isSubpath, resolvePath } from "@/utils/path.utils";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";

/** Contribution identifiers are referenced across surfaces (tabs → pages, slots → actions). */
const PLUGIN_UI_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Matches an absolute URL scheme prefix (`javascript:`, `data:`, `https:` …). */
const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

export function assertOptionalType(value: unknown, type: "boolean" | "number", subject: string): void {
	if (value !== undefined && typeof value !== type)
		throw new DomainError("validation", `Plugin ui.json ${subject} must be a ${type}`, {
			code: "plugin.ui.field_invalid",
			params: { field: subject },
		});
}

export function assertOptionalStringArray(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw new DomainError("validation", `Plugin ui.json ${field} must be an array of strings`, {
			code: "plugin.ui.string_array_invalid",
			params: { field },
		});
	}
}

export function assertUiId(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (!PLUGIN_UI_ID_PATTERN.test(value))
		throw new DomainError("validation", `Plugin ui.json ${field} has unsupported characters: ${value}`, {
			code: "plugin.ui.characters_unsupported",
			params: { field, value },
		});
}

export function optionalUiId(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;

	assertUiId(value, field);

	return value;
}

export function assertLocalizedText(value: unknown, field: string): void {
	if (isNonEmptyString(value)) return;

	if (!isRecord(value))
		throw new DomainError("validation", `Plugin ui.json ${field} must be a string or a locale map`, {
			code: "plugin.ui.locale_text_invalid",
			params: { field },
		});

	const entries = Object.entries(value);
	if (entries.length === 0)
		throw new DomainError("validation", `Plugin ui.json ${field} locale map must not be empty`, {
			code: "plugin.ui.field_empty",
			params: { field },
		});

	for (const [locale, text] of entries) {
		if (!(isNonEmptyString(locale) && isNonEmptyString(text))) {
			throw new DomainError("validation", `Plugin ui.json ${field} locale map values must be non-empty strings`, {
				code: "plugin.ui.locale_text_invalid",
				params: { field },
			});
		}
	}
}

export function assertOptionalStringRecord(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!isRecord(value) || Object.values(value).some((item) => !isNonEmptyString(item))) {
		throw new DomainError("validation", `Plugin ui.json ${field} must be a map of non-empty strings`, {
			code: "plugin.ui.field_invalid",
			params: { field },
		});
	}
}

const ALLOWED_HREF_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Allows only site-relative paths or absolute http(s) URLs. Blocks
 * `javascript:`, `data:`, protocol-relative `//host` and similar schemes a
 * plugin-authored action could otherwise use to execute code or navigate out.
 */
export function assertSafeHref(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (value.startsWith("//") || value.startsWith("\\")) {
		throw new DomainError("validation", `Plugin ui.json ${field} must not be protocol-relative`, {
			code: "plugin.ui.url_invalid",
			params: { field },
		});
	}

	if (value.startsWith("/")) return;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new DomainError("validation", `Plugin ui.json ${field} must be an absolute http(s) URL or a site-relative path`, {
			code: "plugin.ui.url_invalid",
			params: { field },
		});
	}

	if (!ALLOWED_HREF_PROTOCOLS.has(parsed.protocol)) {
		throw new DomainError("validation", `Plugin ui.json ${field} uses an unsupported URL scheme: ${parsed.protocol}`, {
			code: "plugin.ui.url_invalid",
			params: { field },
		});
	}
}

/**
 * A plugin API path is mounted under `/v1/plugins/<pluginId>/`; reject absolute
 * URLs, `..` traversal, query/fragment and backslashes that would let a schema
 * call arbitrary host endpoints. Templated segments stay allowed — the client
 * re-validates the resolved path at request time.
 */
export function assertSafePluginSubPath(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	const withoutLeading = value.startsWith("/") ? value.slice(1) : value;
	if (
		withoutLeading.startsWith("/") ||
		withoutLeading.includes("..") ||
		value.includes("\\") ||
		value.includes("?") ||
		value.includes("#") ||
		URL_SCHEME_PREFIX.test(value)
	) {
		throw new DomainError("validation", `Plugin ui.json ${field} must be a relative plugin path without traversal or query`, {
			code: "plugin.ui.path_invalid",
			params: { field },
		});
	}
}

/**
 * A failure on one field. Interface fields (`ui.*`) are read from ui.json and get the `plugin.ui.*`
 * codes; every other field is read from plugin.json.
 */
function fieldError(
	field: string,
	problem: "not_string" | "not_array" | "path_invalid" | "path_escapes" | "duplicates",
	reason: string,
): DomainError {
	const interfaceField = field.startsWith("ui.");

	return new DomainError("validation", `Plugin ${interfaceField ? "ui.json" : "manifest"} ${field} ${reason}`, {
		code: `plugin.${interfaceField ? "ui." : ""}field_${problem}`,
		params: { field },
	});
}

export function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (!isNonEmptyString(value)) throw fieldError(field, "not_string", "must be a non-empty string");
}

export function assertRelativeString(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (isAbsolutePath(value) || !value.startsWith("./")) {
		throw fieldError(field, "path_invalid", "must be a relative path starting with './'");
	}
}

export function resolvePluginPath(pluginDir: string, path: string, field: string): string {
	const root = resolvePath(pluginDir);
	const resolvedPath = resolvePath(root, path);
	if (!isSubpath(resolvedPath, root)) {
		throw fieldError(field, "path_escapes", `escapes plugin directory: ${path}`);
	}

	return resolvedPath;
}

export function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw fieldError(field, "not_array", "must be an array of non-empty strings");
	}
}

export function assertUnique(values: string[], field: string): void {
	if (new Set(values).size !== values.length) throw fieldError(field, "duplicates", "must not contain duplicates");
}
