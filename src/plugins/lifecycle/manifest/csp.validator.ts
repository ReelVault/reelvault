import { PLUGIN_CSP_DIRECTIVE_SET } from "@reelvault/sdk/plugin";
import { DomainError } from "@/utils/domain.errors";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";

/** A CSP source is a plain http(s) origin — optional `*.` subdomain wildcard and port, never a path. */
const CSP_SOURCE_PATTERN = /^https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/** Hard cap so a malformed manifest cannot bloat the CSP header on every response. */
const CSP_MAX_SOURCES = 50;

/**
 * Plugin-declared CSP additions for the host web UI. Only content directives
 * from the SDK allowlist are accepted, and every source must be a plain origin —
 * a manifest can never inject extra directives or break the header format.
 */
export function validatePluginCsp(value: unknown): void {
	if (!isRecord(value))
		throw new DomainError("validation", "Plugin manifest csp must be an object", {
			code: "plugin.field_not_object",
			params: { field: "csp" },
		});

	let total = 0;
	for (const [directive, sources] of Object.entries(value)) {
		if (!PLUGIN_CSP_DIRECTIVE_SET.has(directive)) {
			throw new DomainError("validation", `Plugin manifest csp has unsupported directive '${directive}'`, {
				code: "plugin.csp_directive_unsupported",
				params: { directive },
			});
		}

		if (!Array.isArray(sources) || sources.length === 0) {
			throw new DomainError("validation", `Plugin manifest csp.${directive} must be a non-empty array of sources`, {
				code: "plugin.field_empty",
				params: { field: `csp.${directive}` },
			});
		}

		for (const source of sources) {
			if (!(isNonEmptyString(source) && CSP_SOURCE_PATTERN.test(source))) {
				throw new DomainError("validation", `Plugin manifest csp.${directive} has an invalid source '${String(source)}'`, {
					code: "plugin.csp_source_invalid",
					params: { directive, source: String(source) },
				});
			}
		}

		total += sources.length;
	}

	if (total > CSP_MAX_SOURCES) {
		throw new DomainError("validation", `Plugin manifest csp declares more than ${CSP_MAX_SOURCES} sources`, {
			code: "plugin.csp_too_many_sources",
			params: { max: CSP_MAX_SOURCES },
		});
	}
}
