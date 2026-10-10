import type {
	ConfigDefinition,
	PluginCapabilityName,
	PluginConfig,
	PluginManifest,
	PluginUiManifest,
	PluginUiSchemaSurface,
} from "@reelvault/sdk/plugin";
import {
	PLUGIN_CAPABILITY_SET,
	PLUGIN_CSP_DIRECTIVE_SET,
	PLUGIN_DIALOG_SIZES as PLUGIN_DIALOG_SIZE_VALUES,
	PLUGIN_SCHEMA_ACTION_TYPES as PLUGIN_SCHEMA_ACTION_TYPE_VALUES,
	PLUGIN_SCHEMA_CONDITION_OPS as PLUGIN_SCHEMA_CONDITION_OP_VALUES,
	PLUGIN_SCHEMA_FIELD_INPUTS as PLUGIN_SCHEMA_FIELD_INPUT_VALUES,
	PLUGIN_SLOT_NAMES as PLUGIN_SLOT_NAME_VALUES,
	PLUGIN_TAB_HOST_NAMES as PLUGIN_TAB_HOST_NAME_VALUES,
} from "@reelvault/sdk/plugin";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { unique } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { isValidSemver } from "@/utils/semver.utils";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";

const CAPABILITY_NAMES: ReadonlySet<string> = PLUGIN_CAPABILITY_SET;

const PLUGIN_SLOT_NAMES: ReadonlySet<string> = new Set(PLUGIN_SLOT_NAME_VALUES);

const PLUGIN_TAB_HOST_NAMES: ReadonlySet<string> = new Set(PLUGIN_TAB_HOST_NAME_VALUES);

const PLUGIN_DIALOG_SIZES: ReadonlySet<string> = new Set(PLUGIN_DIALOG_SIZE_VALUES);

/** Contribution identifiers are referenced across surfaces (tabs → pages, slots → actions). */
const PLUGIN_UI_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Page paths are single URL segments mounted under `/plugins/<id>/page/`. */
const PLUGIN_UI_PAGE_PATH_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Custom element names must contain a hyphen and be lowercase (WHATWG custom elements spec). */
const CUSTOM_ELEMENT_NAME_PATTERN = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

/** A CSP source is a plain http(s) origin — optional `*.` subdomain wildcard and port, never a path. */
const CSP_SOURCE_PATTERN = /^https?:\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/** Hard cap so a malformed manifest cannot bloat the CSP header on every response. */
const CSP_MAX_SOURCES = 50;

/** Matches an absolute URL scheme prefix (`javascript:`, `data:`, `https:` …). */
const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Declarative schema bounds. A schema is admin-installed data rendered by the
 * host; these caps are format/protocol limits (hardware-independent) so a
 * malformed schema cannot exhaust the browser.
 */
const SCHEMA_MAX_BYTES = 256 * 1024;
const SCHEMA_MAX_NODES = 2000;
const SCHEMA_MAX_DEPTH = 32;
const SCHEMA_MAX_FIELDS = 200;
const SCHEMA_MAX_SOURCES = 50;

const SCHEMA_FIELD_INPUTS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_FIELD_INPUT_VALUES);

const SCHEMA_CONDITION_OPS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_CONDITION_OP_VALUES);

const SCHEMA_ACTION_TYPES: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_ACTION_TYPE_VALUES);

export function validatePluginManifest(value: unknown): asserts value is PluginManifest {
	if (!isRecord(value)) throw new ValidationError("Plugin manifest must be an object", { code: "plugin.manifest_not_object" });

	assertNonEmptyString(value.id, "id");
	if (!PLUGIN_IDENTIFIER_PATTERN.test(value.id)) {
		throw new ValidationError(`Plugin manifest id contains unsupported characters: ${value.id}`, {
			code: "plugin.id_invalid",
			params: { id: value.id },
		});
	}

	assertNonEmptyString(value.name, "name");
	assertNonEmptyString(value.version, "version");
	assertRelativeString(value.entry, "entry");

	assertStringArray(value.capabilities, "capabilities");
	if (value.capabilities.length === 0)
		throw new ValidationError("Plugin manifest capabilities must not be empty", { code: "plugin.capabilities_empty" });

	assertUnique(value.capabilities, "capabilities");
	for (const capability of value.capabilities) {
		if (!CAPABILITY_NAMES.has(capability)) {
			throw new ValidationError(`Plugin manifest has unsupported capability '${capability}'`, {
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
			throw new ValidationError(`Plugin manifest minServerVersion must be a semantic version: ${value.minServerVersion}`, {
				code: "plugin.min_server_version_invalid",
				params: { value: value.minServerVersion },
			});
		}
	}

	if (value.csp !== undefined) validatePluginCsp(value.csp);
}

/**
 * Plugin-declared CSP additions for the host web UI. Only content directives
 * from the SDK allowlist are accepted, and every source must be a plain origin —
 * a manifest can never inject extra directives or break the header format.
 */
function validatePluginCsp(value: unknown): void {
	if (!isRecord(value))
		throw new ValidationError("Plugin manifest csp must be an object", { code: "plugin.field_not_object", params: { field: "csp" } });

	let total = 0;
	for (const [directive, sources] of Object.entries(value)) {
		if (!PLUGIN_CSP_DIRECTIVE_SET.has(directive)) {
			throw new ValidationError(`Plugin manifest csp has unsupported directive '${directive}'`, {
				code: "plugin.csp_directive_unsupported",
				params: { directive },
			});
		}

		if (!Array.isArray(sources) || sources.length === 0) {
			throw new ValidationError(`Plugin manifest csp.${directive} must be a non-empty array of sources`, {
				code: "plugin.field_empty",
				params: { field: `csp.${directive}` },
			});
		}

		for (const source of sources) {
			if (!(isNonEmptyString(source) && CSP_SOURCE_PATTERN.test(source))) {
				throw new ValidationError(`Plugin manifest csp.${directive} has an invalid source '${String(source)}'`, {
					code: "plugin.csp_source_invalid",
					params: { directive, source: String(source) },
				});
			}
		}

		total += sources.length;
	}

	if (total > CSP_MAX_SOURCES) {
		throw new ValidationError(`Plugin manifest csp declares more than ${CSP_MAX_SOURCES} sources`, {
			code: "plugin.csp_too_many_sources",
			params: { max: CSP_MAX_SOURCES },
		});
	}
}

export function validatePluginUiManifest(value: unknown): asserts value is PluginUiManifest {
	if (!isRecord(value)) throw new ValidationError("Plugin ui.json must be an object", { code: "plugin.ui.manifest_not_object" });

	assertNonEmptyString(value.name, "ui.name");
	assertNonEmptyString(value.version, "ui.version");
	if (value.defaultLocale !== undefined) assertNonEmptyString(value.defaultLocale, "ui.defaultLocale");

	const declaredDialogIds = collectDeclaredDialogIds(value.dialogs);
	const pageIds = validateUiPages(value.pages, declaredDialogIds);
	const dialogIds = validateUiDialogs(value.dialogs, declaredDialogIds);
	if (value.tabs !== undefined) validateUiTabs(value.tabs, pageIds);

	if (value.slots !== undefined) validateUiSlots(value.slots, pageIds, dialogIds);

	if (value.playbackPreRoll !== undefined) validatePlaybackPreRoll(value.playbackPreRoll);

	if (value.searchProvider !== undefined) validateSearchProvider(value.searchProvider, pageIds);

	// `entry` is the module defining custom elements; required only when a surface
	// uses `tag` (schema-only plugins ship no bundle).
	if (value.entry !== undefined || uiManifestUsesTag(value)) assertRelativeString(value.entry, "ui.entry");
}

/** True when any page/dialog/slot surface renders a custom element (`tag`). */
function uiManifestUsesTag(value: Record<string, unknown>): boolean {
	const pages = Array.isArray(value.pages) ? value.pages : [];
	if (pages.some((page) => isRecord(page) && page.tag !== undefined)) return true;

	const dialogs = Array.isArray(value.dialogs) ? value.dialogs : [];
	if (dialogs.some((dialog) => isRecord(dialog) && dialog.tag !== undefined)) return true;

	const slots = isRecord(value.slots) ? value.slots : {};
	for (const contributions of Object.values(slots)) {
		if (
			Array.isArray(contributions) &&
			contributions.some((entry) => isRecord(entry) && isRecord(entry.element) && entry.element.tag !== undefined)
		) {
			return true;
		}
	}

	return false;
}

function validateUiPages(pages: unknown, dialogIds: ReadonlySet<string>): Set<string> {
	const ids = new Set<string>();
	if (pages === undefined) return ids;

	if (!Array.isArray(pages))
		throw new ValidationError("Plugin ui.json pages must be an array", { code: "plugin.ui.field_not_array", params: { field: "pages" } });

	for (const page of pages) {
		if (!isRecord(page))
			throw new ValidationError("Plugin ui.json pages entries must be objects", {
				code: "plugin.ui.entry_not_object",
				params: { field: "pages" },
			});

		assertUiId(page.id, "ui.pages[].id");
		if (ids.has(page.id))
			throw new ValidationError(`Plugin ui.json has duplicate page id '${page.id}'`, {
				code: "plugin.ui.duplicate_id",
				params: { field: "pages", id: page.id },
			});

		ids.add(page.id);
		if (typeof page.path !== "string" || !PLUGIN_UI_PAGE_PATH_PATTERN.test(page.path)) {
			throw new ValidationError(`Plugin ui.json page '${page.id}' has an invalid path`, {
				code: "plugin.ui.page_path_invalid",
				params: { page: page.id },
			});
		}

		assertLocalizedText(page.name, `ui.pages.${page.id}.name`);
		if (page.icon !== undefined) assertNonEmptyString(page.icon, `ui.pages.${page.id}.icon`);

		validateSurfaceDefinition(page, `ui.pages.${page.id}`, dialogIds);
		assertOptionalType(page.adminOnly, "boolean", `page '${page.id}' adminOnly`);

		if (page.nav !== undefined && page.nav !== false && page.nav !== "user" && page.nav !== "admin") {
			throw new ValidationError(`Plugin ui.json page '${page.id}' nav must be 'user', 'admin' or false`, {
				code: "plugin.ui.page_nav_invalid",
				params: { page: page.id },
			});
		}

		assertOptionalType(page.priority, "number", `page '${page.id}' priority`);
	}

	return ids;
}

/**
 * Dialog ids collected before surface validation so a schema may reference any
 * declared dialog — forward references included. Dialog shapes are validated
 * separately; malformed entries are ignored here and rejected there.
 */
function collectDeclaredDialogIds(dialogs: unknown): Set<string> {
	const ids = new Set<string>();
	if (!Array.isArray(dialogs)) return ids;

	for (const dialog of dialogs) {
		if (isRecord(dialog) && isNonEmptyString(dialog.id)) ids.add(dialog.id);
	}

	return ids;
}

function validateUiDialogs(dialogs: unknown, dialogIds: ReadonlySet<string>): Set<string> {
	const ids = new Set<string>();
	if (dialogs === undefined) return ids;

	if (!Array.isArray(dialogs))
		throw new ValidationError("Plugin ui.json dialogs must be an array", {
			code: "plugin.ui.field_not_array",
			params: { field: "dialogs" },
		});

	for (const dialog of dialogs) {
		if (!isRecord(dialog))
			throw new ValidationError("Plugin ui.json dialogs entries must be objects", {
				code: "plugin.ui.entry_not_object",
				params: { field: "dialogs" },
			});

		assertUiId(dialog.id, "ui.dialogs[].id");
		if (ids.has(dialog.id))
			throw new ValidationError(`Plugin ui.json has duplicate dialog id '${dialog.id}'`, {
				code: "plugin.ui.duplicate_id",
				params: { field: "dialogs", id: dialog.id },
			});

		ids.add(dialog.id);
		assertLocalizedText(dialog.title, `ui.dialogs.${dialog.id}.title`);
		if (dialog.icon !== undefined) assertNonEmptyString(dialog.icon, `ui.dialogs.${dialog.id}.icon`);

		if (dialog.size !== undefined && (typeof dialog.size !== "string" || !PLUGIN_DIALOG_SIZES.has(dialog.size))) {
			throw new ValidationError(`Plugin ui.json dialog '${dialog.id}' has an unsupported size`, {
				code: "plugin.ui.dialog_size_invalid",
				params: { dialog: dialog.id },
			});
		}

		validateSurfaceDefinition(dialog, `ui.dialogs.${dialog.id}`, dialogIds);
		assertOptionalType(dialog.adminOnly, "boolean", `dialog '${dialog.id}' adminOnly`);
	}

	return ids;
}

function validateUiTabs(tabs: unknown, pageIds: ReadonlySet<string>): void {
	if (!isRecord(tabs))
		throw new ValidationError("Plugin ui.json tabs must be an object", { code: "plugin.ui.field_not_object", params: { field: "tabs" } });

	for (const [host, contributions] of Object.entries(tabs)) {
		if (!PLUGIN_TAB_HOST_NAMES.has(host)) {
			throw new ValidationError(`Plugin ui.json has unsupported tab host '${host}'`, {
				code: "plugin.ui.tab_host_unsupported",
				params: { host },
			});
		}

		if (!Array.isArray(contributions))
			throw new ValidationError(`Plugin ui.json tab host '${host}' must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `tabs.${host}` },
			});

		for (const tab of contributions) {
			if (!isRecord(tab))
				throw new ValidationError(`Plugin ui.json tab host '${host}' entries must be objects`, {
					code: "plugin.ui.entry_not_object",
					params: { field: `tabs.${host}` },
				});

			assertUiId(tab.id, `ui.tabs.${host}[].id`);
			if (tab.host !== host)
				throw new ValidationError(`Plugin ui.json tab '${tab.id}' host must match its group '${host}'`, {
					code: "plugin.ui.tab_host_mismatch",
					params: { tab: tab.id, host },
				});

			assertLocalizedText(tab.label, `ui.tabs.${host}.${tab.id}.label`);
			if (tab.icon !== undefined) assertNonEmptyString(tab.icon, `ui.tabs.${host}.${tab.id}.icon`);

			assertNonEmptyString(tab.page, `ui.tabs.${host}.${tab.id}.page`);
			if (!pageIds.has(tab.page))
				throw new ValidationError(`Plugin ui.json tab '${tab.id}' references unknown page '${tab.page}'`, {
					code: "plugin.ui.page_unknown",
					params: { page: tab.page },
				});

			assertOptionalType(tab.adminOnly, "boolean", `tab '${tab.id}' adminOnly`);

			assertOptionalType(tab.priority, "number", `tab '${tab.id}' priority`);
		}
	}
}

function validateUiSlots(slots: unknown, pageIds: ReadonlySet<string>, dialogIds: ReadonlySet<string>): void {
	if (!isRecord(slots))
		throw new ValidationError("Plugin ui.json slots must be an object", { code: "plugin.ui.field_not_object", params: { field: "slots" } });

	for (const [slot, contributions] of Object.entries(slots)) {
		if (!PLUGIN_SLOT_NAMES.has(slot)) {
			throw new ValidationError(`Plugin ui.json has unsupported slot '${slot}'`, { code: "plugin.ui.slot_unsupported", params: { slot } });
		}

		if (!Array.isArray(contributions))
			throw new ValidationError(`Plugin ui.json slot '${slot}' must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `slots.${slot}` },
			});

		const ids = new Set<string>();
		for (const contribution of contributions) {
			const id = validateUiSlotContribution(slot, contribution, pageIds, dialogIds);
			if (id === undefined) continue;

			if (ids.has(id))
				throw new ValidationError(`Plugin ui.json slot '${slot}' declares the id '${id}' twice`, {
					code: "plugin.ui.duplicate_id",
					params: { field: `slots.${slot}`, id },
				});
			ids.add(id);
		}
	}
}

/** The pre-play declaration only carries a relative plugin route path. */
function validatePlaybackPreRoll(value: unknown): asserts value is { endpoint: string } {
	if (!isRecord(value))
		throw new ValidationError("Plugin ui.json playbackPreRoll must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "playbackPreRoll" },
		});

	assertSafePluginSubPath(value.endpoint, "ui.playbackPreRoll.endpoint");
}

/** Search extension: query route, optional request route and an item page reference. */
function validateSearchProvider(
	value: unknown,
	pageIds: ReadonlySet<string>,
): asserts value is { endpoint: string; requestEndpoint?: string; itemPage?: string } {
	if (!isRecord(value))
		throw new ValidationError("Plugin ui.json searchProvider must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "searchProvider" },
		});

	assertSafePluginSubPath(value.endpoint, "ui.searchProvider.endpoint");
	if (value.requestEndpoint !== undefined) assertSafePluginSubPath(value.requestEndpoint, "ui.searchProvider.requestEndpoint");

	if (value.itemPage !== undefined) {
		assertUiId(value.itemPage, "ui.searchProvider.itemPage");
		if (!pageIds.has(value.itemPage)) {
			throw new ValidationError(`Plugin ui.json searchProvider.itemPage references unknown page '${value.itemPage}'`, {
				code: "plugin.ui.page_unknown",
				params: { page: value.itemPage },
			});
		}
	}
}

/** Validates one slot entry and returns its optional `id`, which the caller checks for uniqueness within the slot. */
function validateUiSlotContribution(
	slot: string,
	contribution: unknown,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): string | undefined {
	if (!isRecord(contribution))
		throw new ValidationError(`Plugin ui.json slot '${slot}' entries must be objects`, {
			code: "plugin.ui.entry_not_object",
			params: { field: `slots.${slot}` },
		});

	const id = optionalUiId(contribution.id, `ui.slots.${slot}.id`);
	assertLocalizedText(contribution.label, `ui.slots.${slot}.label`);
	if (contribution.icon !== undefined) assertNonEmptyString(contribution.icon, `ui.slots.${slot}.icon`);

	const hasAction = contribution.action !== undefined;
	const hasElement = contribution.element !== undefined;
	if (hasAction === hasElement) {
		throw new ValidationError(`Plugin ui.json slot '${slot}' entry must declare exactly one of action or element`, {
			code: "plugin.ui.slot_entry_ambiguous",
			params: { slot },
		});
	}

	if (hasAction) validateSlotAction(contribution.action, `ui.slots.${slot}.action`, pageIds, dialogIds);

	if (hasElement) validateUiSurface(contribution.element, `ui.slots.${slot}.element`);

	assertOptionalType(contribution.priority, "number", `slot '${slot}' priority`);

	assertOptionalType(contribution.adminOnly, "boolean", `slot '${slot}' adminOnly`);

	assertOptionalType(contribution.iconOnly, "boolean", `slot '${slot}' iconOnly`);

	return id;
}

function validateSlotAction(action: unknown, field: string, pageIds: ReadonlySet<string>, dialogIds: ReadonlySet<string>): void {
	if (!isRecord(action) || typeof action.type !== "string")
		throw new ValidationError(`Plugin ui.json ${field} must declare a type`, { code: "plugin.ui.action_type_missing", params: { field } });

	switch (action.type) {
		case "page":
			assertNonEmptyString(action.page, `${field}.page`);
			if (!pageIds.has(action.page))
				throw new ValidationError(`Plugin ui.json ${field} references unknown page '${action.page}'`, {
					code: "plugin.ui.page_unknown",
					params: { page: action.page },
				});

			assertOptionalStringRecord(action.params, `${field}.params`);

			return;
		case "dialog":
			assertNonEmptyString(action.dialog, `${field}.dialog`);
			if (!dialogIds.has(action.dialog))
				throw new ValidationError(`Plugin ui.json ${field} references unknown dialog '${action.dialog}'`, {
					code: "plugin.ui.dialog_unknown",
					params: { dialog: action.dialog },
				});

			assertOptionalStringRecord(action.params, `${field}.params`);

			return;
		case "navigate":
			assertSafeHref(action.href, `${field}.href`);

			return;
		case "external":
			assertSafeHref(action.href, `${field}.href`);

			return;
		default:
			throw new ValidationError(`Plugin ui.json ${field} has unsupported type '${action.type}'`, {
				code: "plugin.ui.action_type_unsupported",
				params: { field, type: action.type },
			});
	}
}

function validateUiSurface(surface: unknown, field: string): void {
	if (!isRecord(surface))
		throw new ValidationError(`Plugin ui.json ${field} must be an object`, { code: "plugin.ui.field_not_object", params: { field } });

	assertSurfaceTag(surface.tag, `${field}.tag`);
}

function assertSurfaceTag(tag: unknown, field: string): asserts tag is string {
	if (typeof tag !== "string" || !CUSTOM_ELEMENT_NAME_PATTERN.test(tag)) {
		throw new ValidationError(`Plugin ui.json ${field} must be a valid custom element tag (lowercase, hyphenated)`, {
			code: "plugin.ui.element_tag_invalid",
			params: { field },
		});
	}
}

/** A page/dialog renders either a custom element (`tag`) or a schema exactly once. */
function validateSurfaceDefinition(surface: Record<string, unknown>, field: string, dialogIds: ReadonlySet<string>): void {
	const variants = [surface.tag !== undefined, surface.schema !== undefined, surface.schemaRef !== undefined].filter(Boolean).length;
	if (variants !== 1) {
		throw new ValidationError(`Plugin ui.json ${field} must declare exactly one of tag, schema or schemaRef`, {
			code: "plugin.ui.element_source_invalid",
			params: { field },
		});
	}

	if (surface.tag !== undefined) assertSurfaceTag(surface.tag, `${field}.tag`);

	if (surface.schemaRef !== undefined) assertRelativeString(surface.schemaRef, `${field}.schemaRef`);

	if (surface.schema !== undefined) validatePluginSchema(surface.schema, `${field}.schema`, dialogIds);
}

/** Validates a declarative schema (used both for inline schemas and loaded schemaRef files). */
export function validatePluginSchema(
	value: unknown,
	field: string,
	dialogIds?: ReadonlySet<string>,
): asserts value is PluginUiSchemaSurface {
	if (!isRecord(value))
		throw new ValidationError(`Plugin ui.json ${field} must be an object`, { code: "plugin.ui.field_not_object", params: { field } });

	if (value.data !== undefined) {
		if (!isRecord(value.data))
			throw new ValidationError(`Plugin ui.json ${field}.data must be an object`, {
				code: "plugin.ui.field_not_object",
				params: { field: `${field}.data` },
			});

		const sources = Object.entries(value.data);
		if (sources.length > SCHEMA_MAX_SOURCES)
			throw new ValidationError(`Plugin ui.json ${field}.data has too many sources`, {
				code: "plugin.ui.data_too_many_sources",
				params: { field },
			});

		for (const [name, source] of sources) {
			if (!isRecord(source))
				throw new ValidationError(`Plugin ui.json ${field}.data.${name} must be an object`, {
					code: "plugin.ui.field_not_object",
					params: { field: `${field}.data.${name}` },
				});

			assertSafePluginSubPath(source.path, `${field}.data.${name}.path`);
		}
	}

	if (value.onMount !== undefined) {
		if (!Array.isArray(value.onMount))
			throw new ValidationError(`Plugin ui.json ${field}.onMount must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `${field}.onMount` },
			});

		for (const [index, action] of value.onMount.entries()) validateSchemaAction(action, `${field}.onMount[${index}]`, dialogIds);
	}

	const counter = { count: 0, fields: 0 };
	validateSchemaNodes(value.body, `${field}.body`, 0, counter, dialogIds);
}

function validateSchemaField(entry: Record<string, unknown>, fieldName: string): void {
	assertNonEmptyString(entry.name, `${fieldName}.name`);
	if (typeof entry.input !== "string" || !SCHEMA_FIELD_INPUTS.has(entry.input)) {
		throw new ValidationError(`Plugin ui.json ${fieldName}.input is unsupported`, {
			code: "plugin.ui.field_unsupported",
			params: { field: `${fieldName}.input` },
		});
	}

	assertLocalizedText(entry.label, `${fieldName}.label`);
	if (entry.description !== undefined) assertLocalizedText(entry.description, `${fieldName}.description`);

	if (entry.placeholder !== undefined) assertLocalizedText(entry.placeholder, `${fieldName}.placeholder`);

	assertOptionalType(entry.required, "boolean", `${fieldName}.required`);

	if (entry.options !== undefined) {
		if (!Array.isArray(entry.options))
			throw new ValidationError(`Plugin ui.json ${fieldName}.options must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `${fieldName}.options` },
			});

		for (const option of entry.options) {
			if (!isRecord(option))
				throw new ValidationError(`Plugin ui.json ${fieldName}.options entries must be objects`, {
					code: "plugin.ui.entry_not_object",
					params: { field: `${fieldName}.options` },
				});

			assertLocalizedText(option.label, `${fieldName}.options[].label`);
			if (typeof option.value !== "string" && typeof option.value !== "number") {
				throw new ValidationError(`Plugin ui.json ${fieldName}.options[].value must be a string or number`, {
					code: "plugin.ui.option_value_invalid",
					params: { field: `${fieldName}.options[].value` },
				});
			}
		}
	}

	if (entry.hiddenIf !== undefined) validateSchemaCondition(entry.hiddenIf, `${fieldName}.hiddenIf`);
}

function validateSchemaNodes(
	nodes: unknown,
	field: string,
	depth: number,
	counter: { count: number; fields: number },
	dialogIds: ReadonlySet<string> | undefined,
): void {
	if (depth > SCHEMA_MAX_DEPTH)
		throw new ValidationError(`Plugin ui.json ${field} exceeds the maximum nesting depth`, {
			code: "plugin.ui.nesting_too_deep",
			params: { field },
		});

	if (!Array.isArray(nodes))
		throw new ValidationError(`Plugin ui.json ${field} must be an array`, { code: "plugin.ui.field_not_array", params: { field } });

	for (const node of nodes) validateSchemaNode(node, field, depth, counter, dialogIds);
}

interface SchemaNodeContext {
	field: string;
	depth: number;
	counter: { count: number; fields: number };
	dialogIds: ReadonlySet<string> | undefined;
}

function validateFieldNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	context.counter.fields += 1;
	if (context.counter.fields > SCHEMA_MAX_FIELDS)
		throw new ValidationError(`Plugin ui.json ${context.field} has too many fields`, {
			code: "plugin.ui.too_many_fields",
			params: { field: context.field },
		});

	validateSchemaField(node, context.field);
}

function validateContainerNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (node.type === "card" || node.type === "section") {
		if (node.title !== undefined) assertLocalizedText(node.title, `${field}.title`);

		if (node.description !== undefined) assertLocalizedText(node.description, `${field}.description`);
	}

	validateSchemaNodes(node.children, `${field}.children`, context.depth + 1, context.counter, context.dialogIds);
}

function validateTabsNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (!Array.isArray(node.tabs))
		throw new ValidationError(`Plugin ui.json ${field}.tabs must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.tabs` },
		});

	for (const [index, tab] of node.tabs.entries()) {
		if (!isRecord(tab))
			throw new ValidationError(`Plugin ui.json ${field}.tabs[${index}] must be an object`, {
				code: "plugin.ui.field_not_object",
				params: { field: `${field}.tabs[${index}]` },
			});

		assertLocalizedText(tab.label, `${field}.tabs[${index}].label`);
		validateSchemaNodes(tab.children, `${field}.tabs[${index}].children`, context.depth + 1, context.counter, context.dialogIds);
	}
}

function validateTextNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertLocalizedText(node.text, `${context.field}.text`);
}

function validateAlertNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	if (node.title !== undefined) assertLocalizedText(node.title, `${context.field}.title`);

	if (node.description !== undefined) assertLocalizedText(node.description, `${context.field}.description`);
}

function validateButtonNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	assertLocalizedText(node.label, `${field}.label`);
	validateSchemaAction(node.action, `${field}.action`, context.dialogIds);
	if (node.disabledIf !== undefined) validateSchemaCondition(node.disabledIf, `${field}.disabledIf`);

	if (node.hiddenIf !== undefined) validateSchemaCondition(node.hiddenIf, `${field}.hiddenIf`);
}

function validateStatsNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	if (!Array.isArray(node.items))
		throw new ValidationError(`Plugin ui.json ${field}.items must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.items` },
		});

	for (const item of node.items) {
		if (!isRecord(item))
			throw new ValidationError(`Plugin ui.json ${field}.items entries must be objects`, {
				code: "plugin.ui.entry_not_object",
				params: { field: `${field}.items` },
			});

		assertLocalizedText(item.label, `${field}.items[].label`);
		assertNonEmptyString(item.value, `${field}.items[].value`);
	}
}

function validateTableNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	assertNonEmptyString(node.source, `${field}.source`);
	if (!Array.isArray(node.columns))
		throw new ValidationError(`Plugin ui.json ${field}.columns must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field: `${field}.columns` },
		});

	for (const column of node.columns) {
		if (!isRecord(column))
			throw new ValidationError(`Plugin ui.json ${field}.columns entries must be objects`, {
				code: "plugin.ui.entry_not_object",
				params: { field: `${field}.columns` },
			});

		assertLocalizedText(column.label, `${field}.columns[].label`);
		assertNonEmptyString(column.value, `${field}.columns[].value`);
	}

	if (node.rowActions !== undefined)
		validateSchemaNodes(node.rowActions, `${field}.rowActions`, context.depth + 1, context.counter, context.dialogIds);
}

function validateListNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertNonEmptyString(node.source, `${context.field}.source`);
	validateSchemaNodes(node.item, `${context.field}.item`, context.depth + 1, context.counter, context.dialogIds);
}

function validateEmbedNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	assertSafeHref(node.src, `${context.field}.src`);
	if (node.title !== undefined) assertLocalizedText(node.title, `${context.field}.title`);
}

function validateIfNode(node: Record<string, unknown>, context: SchemaNodeContext): void {
	const { field } = context;
	validateSchemaCondition(node.condition, `${field}.condition`);
	validateSchemaNodes(node.content, `${field}.content`, context.depth + 1, context.counter, context.dialogIds);
	if (node.otherwise !== undefined)
		validateSchemaNodes(node.otherwise, `${field}.otherwise`, context.depth + 1, context.counter, context.dialogIds);
}

function validateNoopNode(): void {
	// These nodes carry no schema-declared properties.
}

type SchemaNodeValidator = (node: Record<string, unknown>, context: SchemaNodeContext) => void;

const schemaNodeValidators: Readonly<Record<string, SchemaNodeValidator>> = {
	field: validateFieldNode,
	stack: validateContainerNode,
	card: validateContainerNode,
	section: validateContainerNode,
	row: validateContainerNode,
	grid: validateContainerNode,
	tabs: validateTabsNode,
	heading: validateTextNode,
	text: validateTextNode,
	badge: validateTextNode,
	alert: validateAlertNode,
	button: validateButtonNode,
	stats: validateStatsNode,
	table: validateTableNode,
	list: validateListNode,
	foreach: validateListNode,
	embed: validateEmbedNode,
	if: validateIfNode,
	separator: validateNoopNode,
	empty: validateNoopNode,
};

function validateSchemaNode(
	node: unknown,
	field: string,
	depth: number,
	counter: { count: number; fields: number },
	dialogIds: ReadonlySet<string> | undefined,
): void {
	counter.count += 1;
	if (counter.count > SCHEMA_MAX_NODES)
		throw new ValidationError(`Plugin ui.json ${field} exceeds the maximum node count`, {
			code: "plugin.ui.too_many_nodes",
			params: { field },
		});

	if (!isRecord(node) || typeof node.type !== "string")
		throw new ValidationError(`Plugin ui.json ${field} has an unsupported node type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});

	const validator = schemaNodeValidators[node.type];
	if (!validator)
		throw new ValidationError(`Plugin ui.json ${field} has an unsupported node type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});

	validator(node, { field: `${field}.${node.type}`, depth, counter, dialogIds });
}

function validateSchemaAction(action: unknown, field: string, dialogIds?: ReadonlySet<string>): void {
	if (!isRecord(action) || typeof action.type !== "string" || !SCHEMA_ACTION_TYPES.has(action.type)) {
		throw new ValidationError(`Plugin ui.json ${field} has an unsupported action type`, {
			code: "plugin.ui.field_unsupported",
			params: { field },
		});
	}

	switch (action.type) {
		case "submit":
		case "call":
		case "delete":
			assertSafePluginSubPath(action.path, `${field}.path`);
			assertOptionalStringArray(action.refresh, `${field}.refresh`);

			return;
		case "navigate":
			assertSafeHref(action.to, `${field}.to`);

			return;
		case "openDialog":
			assertNonEmptyString(action.dialog, `${field}.dialog`);
			if (dialogIds && !dialogIds.has(action.dialog)) {
				throw new ValidationError(`Plugin ui.json ${field} references unknown dialog '${action.dialog}'`, {
					code: "plugin.ui.dialog_unknown",
					params: { dialog: action.dialog },
				});
			}

			return;
		case "close":
			return;
		case "toast":
			if (action.level !== "success" && action.level !== "error" && action.level !== "info") {
				throw new ValidationError(`Plugin ui.json ${field}.level must be success, error or info`, {
					code: "plugin.ui.level_invalid",
					params: { field: `${field}.level` },
				});
			}

			assertLocalizedText(action.message, `${field}.message`);

			return;
		case "refresh":
			assertOptionalStringArray(action.sources, `${field}.sources`);

			return;
		default:
			throw new ValidationError(`Plugin ui.json ${field} has an unsupported action type`, {
				code: "plugin.ui.field_unsupported",
				params: { field },
			});
	}
}

function validateSchemaCondition(condition: unknown, field: string): void {
	if (!isRecord(condition))
		throw new ValidationError(`Plugin ui.json ${field} must be an object`, { code: "plugin.ui.field_not_object", params: { field } });

	assertNonEmptyString(condition.left, `${field}.left`);
	if (typeof condition.op !== "string" || !SCHEMA_CONDITION_OPS.has(condition.op)) {
		throw new ValidationError(`Plugin ui.json ${field}.op is unsupported`, {
			code: "plugin.ui.field_unsupported",
			params: { field: `${field}.op` },
		});
	}
}

function assertOptionalType(value: unknown, type: "boolean" | "number", subject: string): void {
	if (value !== undefined && typeof value !== type)
		throw new ValidationError(`Plugin ui.json ${subject} must be a ${type}`, {
			code: "plugin.ui.field_invalid",
			params: { field: subject },
		});
}

function assertOptionalStringArray(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw new ValidationError(`Plugin ui.json ${field} must be an array of strings`, {
			code: "plugin.ui.string_array_invalid",
			params: { field },
		});
	}
}

function assertUiId(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (!PLUGIN_UI_ID_PATTERN.test(value))
		throw new ValidationError(`Plugin ui.json ${field} has unsupported characters: ${value}`, {
			code: "plugin.ui.characters_unsupported",
			params: { field, value },
		});
}

function optionalUiId(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;

	assertUiId(value, field);

	return value;
}

function assertLocalizedText(value: unknown, field: string): void {
	if (isNonEmptyString(value)) return;

	if (!isRecord(value))
		throw new ValidationError(`Plugin ui.json ${field} must be a string or a locale map`, {
			code: "plugin.ui.locale_text_invalid",
			params: { field },
		});

	const entries = Object.entries(value);
	if (entries.length === 0)
		throw new ValidationError(`Plugin ui.json ${field} locale map must not be empty`, { code: "plugin.ui.field_empty", params: { field } });

	for (const [locale, text] of entries) {
		if (!(isNonEmptyString(locale) && isNonEmptyString(text))) {
			throw new ValidationError(`Plugin ui.json ${field} locale map values must be non-empty strings`, {
				code: "plugin.ui.locale_text_invalid",
				params: { field },
			});
		}
	}
}

function assertOptionalStringRecord(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!isRecord(value) || Object.values(value).some((item) => !isNonEmptyString(item))) {
		throw new ValidationError(`Plugin ui.json ${field} must be a map of non-empty strings`, {
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
function assertSafeHref(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (value.startsWith("//") || value.startsWith("\\")) {
		throw new ValidationError(`Plugin ui.json ${field} must not be protocol-relative`, {
			code: "plugin.ui.url_invalid",
			params: { field },
		});
	}

	if (value.startsWith("/")) return;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new ValidationError(`Plugin ui.json ${field} must be an absolute http(s) URL or a site-relative path`, {
			code: "plugin.ui.url_invalid",
			params: { field },
		});
	}

	if (!ALLOWED_HREF_PROTOCOLS.has(parsed.protocol)) {
		throw new ValidationError(`Plugin ui.json ${field} uses an unsupported URL scheme: ${parsed.protocol}`, {
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
function assertSafePluginSubPath(value: unknown, field: string): asserts value is string {
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
		throw new ValidationError(`Plugin ui.json ${field} must be a relative plugin path without traversal or query`, {
			code: "plugin.ui.path_invalid",
			params: { field },
		});
	}
}

export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
	const manifestPath = PathUtils.join(pluginDir, "plugin.json");
	const manifest = await FileUtils.readJson<unknown>(manifestPath);
	if (!manifest) throw new ValidationError(`Plugin is missing a valid plugin.json: ${manifestPath}`, { code: "plugin.manifest_missing" });

	validatePluginManifest(manifest);

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
		throw new ValidationError(`Plugin ui.json ${field}.schemaRef is missing or unreadable: ${ref}`, {
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
		throw new ValidationError(`Plugin uses capabilities missing from plugin.json: ${missing.join(", ")}`, {
			code: "plugin.capability_undeclared",
			params: { capability: missing.join(", ") },
		});
	}
}

export function validatePluginConfig(config: unknown, definition?: ConfigDefinition): PluginConfig {
	const validated = definition ? definition.parse(config) : config;
	if (!isRecord(validated)) throw new ValidationError("Plugin configuration must be an object", { code: "plugin.config_not_object" });

	return validated;
}

/**
 * A failure on one field. Interface fields (`ui.*`) are read from ui.json and get the `plugin.ui.*`
 * codes; every other field is read from plugin.json.
 */
function fieldError(
	field: string,
	problem: "not_string" | "not_array" | "path_invalid" | "path_escapes" | "duplicates",
	reason: string,
): ValidationError {
	const interfaceField = field.startsWith("ui.");

	return new ValidationError(`Plugin ${interfaceField ? "ui.json" : "manifest"} ${field} ${reason}`, {
		code: `plugin.${interfaceField ? "ui." : ""}field_${problem}`,
		params: { field },
	});
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (!isNonEmptyString(value)) throw fieldError(field, "not_string", "must be a non-empty string");
}

function assertRelativeString(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (PathUtils.isAbsolute(value) || !value.startsWith("./")) {
		throw fieldError(field, "path_invalid", "must be a relative path starting with './'");
	}
}

function resolvePluginPath(pluginDir: string, path: string, field: string): string {
	const root = PathUtils.resolve(pluginDir);
	const resolvedPath = PathUtils.resolve(root, path);
	if (!PathUtils.isSubpath(resolvedPath, root)) {
		throw fieldError(field, "path_escapes", `escapes plugin directory: ${path}`);
	}

	return resolvedPath;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw fieldError(field, "not_array", "must be an array of non-empty strings");
	}
}

function assertUnique(values: string[], field: string): void {
	if (new Set(values).size !== values.length) throw fieldError(field, "duplicates", "must not contain duplicates");
}
