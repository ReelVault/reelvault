import type {
	ConfigDefinition,
	PluginCapabilityName,
	PluginConfig,
	PluginManifest,
	PluginUiManifest,
	PluginUiSchemaSurface,
} from "@reelvault/sdk/plugin";
import { PLUGIN_CAPABILITY_SET } from "@reelvault/sdk/plugin";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { isValidSemver } from "@/utils/semver.utils";
import { isRecord } from "@/utils/type.utils";
import { validatePluginCsp } from "./manifest/csp.validator";
import { SCHEMA_MAX_BYTES, validatePluginSchema } from "./manifest/schema.validator";
import {
	assertNonEmptyString,
	assertRelativeString,
	assertSafeHref,
	assertStringArray,
	assertUnique,
	resolvePluginPath,
} from "./manifest/shared.utils";

const CAPABILITY_NAMES: ReadonlySet<string> = PLUGIN_CAPABILITY_SET;

export function validatePluginManifest(value: unknown): asserts value is PluginManifest {
	if (!isRecord(value)) throw new DomainError("validation", "Plugin manifest must be an object", { code: "plugin.manifest_not_object" });

	assertNonEmptyString(value.id, "id");
	if (!PLUGIN_IDENTIFIER_PATTERN.test(value.id)) {
		throw new DomainError("validation", `Plugin manifest id contains unsupported characters: ${value.id}`, {
			code: "plugin.id_invalid",
			params: { id: value.id },
		});
	}

	assertNonEmptyString(value.name, "name");
	assertNonEmptyString(value.version, "version");
	assertRelativeString(value.entry, "entry");

	assertStringArray(value.capabilities, "capabilities");
	if (value.capabilities.length === 0)
		throw new DomainError("validation", "Plugin manifest capabilities must not be empty", { code: "plugin.capabilities_empty" });

	assertUnique(value.capabilities, "capabilities");
	for (const capability of value.capabilities) {
		if (!CAPABILITY_NAMES.has(capability)) {
			throw new DomainError("validation", `Plugin manifest has unsupported capability '${capability}'`, {
				code: "plugin.capability_unsupported",
				params: { capability },
			});
		}
	}

	if (value.description !== undefined) assertNonEmptyString(value.description, "description");

	if (value.homepage !== undefined) assertSafeHref(value.homepage, "homepage");

	if (value.license !== undefined) assertNonEmptyString(value.license, "license");

	if (value.minServerVersion !== undefined) {
		assertNonEmptyString(value.minServerVersion, "minServerVersion");
		if (!isValidSemver(value.minServerVersion)) {
			throw new DomainError("validation", `Plugin manifest minServerVersion must be a semantic version: ${value.minServerVersion}`, {
				code: "plugin.min_server_version_invalid",
				params: { value: value.minServerVersion },
			});
		}
	}

	if (value.csp !== undefined) validatePluginCsp(value.csp);
}

/**
 * The parsed manifest of a plugin directory, keyed by the file's (size, mtime).
 *
 * The manifest is read and validated on every admin request that shows a
 * plugin, so the parse is cached until the file changes. The timestamp keeps
 * its sub-millisecond precision: a manifest rewritten in the same millisecond
 * (the version bump of an upgrade) must not read as unchanged.
 */
const manifestCache = new Map<string, { signature: string; manifest: PluginManifest }>();

export async function loadPluginManifest(pluginDir: string, options?: { fresh?: boolean | undefined }): Promise<PluginManifest> {
	const manifestPath = PathUtils.join(pluginDir, "plugin.json");
	const stats = await FileUtils.getStats(manifestPath);
	const signature = stats ? `${stats.size}:${stats.mtimeMs}` : "missing";
	const cached = manifestCache.get(manifestPath);
	if (!options?.fresh && cached?.signature === signature) return cached.manifest;

	const manifest = await FileUtils.readJson<unknown>(manifestPath);
	if (!manifest)
		throw new DomainError("validation", `Plugin is missing a valid plugin.json: ${manifestPath}`, { code: "plugin.manifest_missing" });

	validatePluginManifest(manifest);
	manifestCache.set(manifestPath, { signature, manifest });

	return manifest;
}

export function resolvePluginEntry(pluginDir: string, manifest: PluginManifest): string {
	return resolvePluginPath(pluginDir, manifest.entry, "entry");
}

/** Loads a `schemaRef` file, validates it and returns the schema surface. */
async function loadResolvedSchema(
	pluginDir: string,
	ref: string,
	field: string,
	dialogIds: ReadonlySet<string>,
): Promise<PluginUiSchemaSurface> {
	const refPath = resolvePluginPath(pluginDir, ref, `${field}.schemaRef`);
	const raw = await FileUtils.readJson<unknown>(refPath, { maxSize: SCHEMA_MAX_BYTES });
	if (raw === null)
		throw new DomainError("validation", `Plugin ui.json ${field}.schemaRef is missing or unreadable: ${ref}`, {
			code: "plugin.ui.schema_ref_missing",
			params: { field: `${field}.schemaRef`, ref },
		});

	validatePluginSchema(raw, `${field}.schema`, dialogIds);

	return raw;
}

/**
 * Inlines every `schemaRef` into the manifest so the client receives renderable
 * schemas in the aggregated UI manifest (no extra fetch, role filtering applies).
 */
export async function resolvePluginUiSchemas(pluginDir: string, manifest: PluginUiManifest): Promise<PluginUiManifest> {
	const dialogIds = new Set((manifest.dialogs ?? []).map((dialog) => dialog.id));
	const pages = manifest.pages
		? await Promise.all(
				manifest.pages.map(async (page, index) => {
					if (!page.schemaRef) return page;

					const schema = await loadResolvedSchema(pluginDir, page.schemaRef, `ui.pages[${index}]`, dialogIds);

					return { ...page, schema, schemaRef: undefined };
				}),
			)
		: undefined;

	const dialogs = manifest.dialogs
		? await Promise.all(
				manifest.dialogs.map(async (dialog, index) => {
					if (!dialog.schemaRef) return dialog;

					const schema = await loadResolvedSchema(pluginDir, dialog.schemaRef, `ui.dialogs[${index}]`, dialogIds);

					return { ...dialog, schema, schemaRef: undefined };
				}),
			)
		: undefined;

	return {
		...manifest,
		...(pages ? { pages } : {}),
		...(dialogs ? { dialogs } : {}),
	};
}

export function assertDeclaredPluginCapabilities(
	declaredCapabilities: readonly PluginCapabilityName[],
	usedCapabilities: Iterable<PluginCapabilityName>,
): void {
	const declared = new Set(declaredCapabilities);
	const missing = unique([...usedCapabilities]).filter((capability) => !declared.has(capability));
	if (missing.length > 0) {
		throw new DomainError("validation", `Plugin uses capabilities missing from plugin.json: ${missing.join(", ")}`, {
			code: "plugin.capability_undeclared",
			params: { capability: missing.join(", ") },
		});
	}
}

export function validatePluginConfig(config: unknown, definition?: ConfigDefinition): PluginConfig {
	const validated = definition ? definition.parse(config) : config;
	if (!isRecord(validated))
		throw new DomainError("validation", "Plugin configuration must be an object", { code: "plugin.config_not_object" });

	return validated;
}
