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
	PLUGIN_DIALOG_SIZES as PLUGIN_DIALOG_SIZE_VALUES,
	PLUGIN_SCHEMA_ACTION_TYPES as PLUGIN_SCHEMA_ACTION_TYPE_VALUES,
	PLUGIN_SCHEMA_CONDITION_OPS as PLUGIN_SCHEMA_CONDITION_OP_VALUES,
	PLUGIN_SCHEMA_FIELD_INPUTS as PLUGIN_SCHEMA_FIELD_INPUT_VALUES,
	PLUGIN_SCHEMA_NODE_TYPES as PLUGIN_SCHEMA_NODE_TYPE_VALUES,
	PLUGIN_SLOT_NAMES as PLUGIN_SLOT_NAME_VALUES,
	PLUGIN_TAB_HOST_NAMES as PLUGIN_TAB_HOST_NAME_VALUES,
} from "@reelvault/sdk/plugin";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { unique } from "@/utils/array.utils";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
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

const SCHEMA_NODE_TYPES: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_NODE_TYPE_VALUES);

const SCHEMA_FIELD_INPUTS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_FIELD_INPUT_VALUES);

const SCHEMA_CONDITION_OPS: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_CONDITION_OP_VALUES);

const SCHEMA_ACTION_TYPES: ReadonlySet<string> = new Set(PLUGIN_SCHEMA_ACTION_TYPE_VALUES);

export function validatePluginManifest(value: unknown): asserts value is PluginManifest {
	if (!isRecord(value)) throw new ValidationError("Plugin manifest must be an object");

	assertNonEmptyString(value.id, "id");
	if (!PLUGIN_IDENTIFIER_PATTERN.test(value.id)) {
		throw new ValidationError(`Plugin manifest id contains unsupported characters: ${value.id}`);
	}

	assertNonEmptyString(value.name, "name");
	assertNonEmptyString(value.version, "version");
	assertRelativeString(value.entry, "entry");

	assertStringArray(value.capabilities, "capabilities");
	if (value.capabilities.length === 0) throw new ValidationError("Plugin manifest capabilities must not be empty");

	assertUnique(value.capabilities, "capabilities");
	for (const capability of value.capabilities) {
		if (!CAPABILITY_NAMES.has(capability)) {
			throw new ValidationError(`Plugin manifest has unsupported capability '${capability}'`);
		}
	}

	if (value.description !== undefined) assertNonEmptyString(value.description, "description");

	if (value.homepage !== undefined) assertSafeHref(value.homepage, "homepage");

	if (value.license !== undefined) assertNonEmptyString(value.license, "license");
}

export function validatePluginUiManifest(value: unknown): asserts value is PluginUiManifest {
	if (!isRecord(value)) throw new ValidationError("Plugin ui.json must be an object");

	assertNonEmptyString(value.name, "ui.name");
	assertNonEmptyString(value.version, "ui.version");
	if (value.defaultLocale !== undefined) assertNonEmptyString(value.defaultLocale, "ui.defaultLocale");

	const pageIds = validateUiPages(value.pages);
	const dialogIds = validateUiDialogs(value.dialogs);
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

function validateUiPages(pages: unknown): Set<string> {
	const ids = new Set<string>();
	if (pages === undefined) return ids;

	if (!Array.isArray(pages)) throw new ValidationError("Plugin ui.json pages must be an array");

	for (const page of pages) {
		if (!isRecord(page)) throw new ValidationError("Plugin ui.json pages entries must be objects");

		assertUiId(page.id, "ui.pages[].id");
		if (ids.has(page.id)) throw new ValidationError(`Plugin ui.json has duplicate page id '${page.id}'`);

		ids.add(page.id);
		if (typeof page.path !== "string" || !PLUGIN_UI_PAGE_PATH_PATTERN.test(page.path)) {
			throw new ValidationError(`Plugin ui.json page '${page.id}' has an invalid path`);
		}

		assertLocalizedText(page.name, `ui.pages.${page.id}.name`);
		if (page.icon !== undefined) assertNonEmptyString(page.icon, `ui.pages.${page.id}.icon`);

		validateSurfaceDefinition(page, `ui.pages.${page.id}`);
		if (page.adminOnly !== undefined && typeof page.adminOnly !== "boolean") {
			throw new ValidationError(`Plugin ui.json page '${page.id}' adminOnly must be a boolean`);
		}

		if (page.nav !== undefined && page.nav !== false && page.nav !== "user" && page.nav !== "admin") {
			throw new ValidationError(`Plugin ui.json page '${page.id}' nav must be 'user', 'admin' or false`);
		}

		if (page.priority !== undefined && typeof page.priority !== "number") {
			throw new ValidationError(`Plugin ui.json page '${page.id}' priority must be a number`);
		}
	}

	return ids;
}

function validateUiDialogs(dialogs: unknown): Set<string> {
	const ids = new Set<string>();
	if (dialogs === undefined) return ids;

	if (!Array.isArray(dialogs)) throw new ValidationError("Plugin ui.json dialogs must be an array");

	for (const dialog of dialogs) {
		if (!isRecord(dialog)) throw new ValidationError("Plugin ui.json dialogs entries must be objects");

		assertUiId(dialog.id, "ui.dialogs[].id");
		if (ids.has(dialog.id)) throw new ValidationError(`Plugin ui.json has duplicate dialog id '${dialog.id}'`);

		ids.add(dialog.id);
		assertLocalizedText(dialog.title, `ui.dialogs.${dialog.id}.title`);
		if (dialog.icon !== undefined) assertNonEmptyString(dialog.icon, `ui.dialogs.${dialog.id}.icon`);

		if (dialog.size !== undefined && (typeof dialog.size !== "string" || !PLUGIN_DIALOG_SIZES.has(dialog.size))) {
			throw new ValidationError(`Plugin ui.json dialog '${dialog.id}' has an unsupported size`);
		}

		validateSurfaceDefinition(dialog, `ui.dialogs.${dialog.id}`);
		if (dialog.adminOnly !== undefined && typeof dialog.adminOnly !== "boolean") {
			throw new ValidationError(`Plugin ui.json dialog '${dialog.id}' adminOnly must be a boolean`);
		}
	}

	return ids;
}

function validateUiTabs(tabs: unknown, pageIds: ReadonlySet<string>): void {
	if (!isRecord(tabs)) throw new ValidationError("Plugin ui.json tabs must be an object");

	for (const [host, contributions] of Object.entries(tabs)) {
		if (!PLUGIN_TAB_HOST_NAMES.has(host)) {
			throw new ValidationError(`Plugin ui.json has unsupported tab host '${host}'`);
		}

		if (!Array.isArray(contributions)) throw new ValidationError(`Plugin ui.json tab host '${host}' must be an array`);

		for (const tab of contributions) {
			if (!isRecord(tab)) throw new ValidationError(`Plugin ui.json tab host '${host}' entries must be objects`);

			assertUiId(tab.id, `ui.tabs.${host}[].id`);
			if (tab.host !== host) throw new ValidationError(`Plugin ui.json tab '${tab.id}' host must match its group '${host}'`);

			assertLocalizedText(tab.label, `ui.tabs.${host}.${tab.id}.label`);
			if (tab.icon !== undefined) assertNonEmptyString(tab.icon, `ui.tabs.${host}.${tab.id}.icon`);

			assertNonEmptyString(tab.page, `ui.tabs.${host}.${tab.id}.page`);
			if (!pageIds.has(tab.page)) throw new ValidationError(`Plugin ui.json tab '${tab.id}' references unknown page '${tab.page}'`);

			if (tab.adminOnly !== undefined && typeof tab.adminOnly !== "boolean") {
				throw new ValidationError(`Plugin ui.json tab '${tab.id}' adminOnly must be a boolean`);
			}

			if (tab.priority !== undefined && typeof tab.priority !== "number") {
				throw new ValidationError(`Plugin ui.json tab '${tab.id}' priority must be a number`);
			}
		}
	}
}

function validateUiSlots(slots: unknown, pageIds: ReadonlySet<string>, dialogIds: ReadonlySet<string>): void {
	if (!isRecord(slots)) throw new ValidationError("Plugin ui.json slots must be an object");

	for (const [slot, contributions] of Object.entries(slots)) {
		if (!PLUGIN_SLOT_NAMES.has(slot)) {
			throw new ValidationError(`Plugin ui.json has unsupported slot '${slot}'`);
		}

		if (!Array.isArray(contributions)) throw new ValidationError(`Plugin ui.json slot '${slot}' must be an array`);

		for (const contribution of contributions) validateUiSlotContribution(slot, contribution, pageIds, dialogIds);
	}
}

/** The pre-play declaration only carries a relative plugin route path. */
function validatePlaybackPreRoll(value: unknown): asserts value is { endpoint: string } {
	if (!isRecord(value)) throw new ValidationError("Plugin ui.json playbackPreRoll must be an object");

	assertSafePluginSubPath(value.endpoint, "ui.playbackPreRoll.endpoint");
}

/** Search extension: query route, optional request route and an item page reference. */
function validateSearchProvider(
	value: unknown,
	pageIds: ReadonlySet<string>,
): asserts value is { endpoint: string; requestEndpoint?: string; itemPage?: string } {
	if (!isRecord(value)) throw new ValidationError("Plugin ui.json searchProvider must be an object");

	assertSafePluginSubPath(value.endpoint, "ui.searchProvider.endpoint");
	if (value.requestEndpoint !== undefined) assertSafePluginSubPath(value.requestEndpoint, "ui.searchProvider.requestEndpoint");

	if (value.itemPage !== undefined) {
		assertUiId(value.itemPage, "ui.searchProvider.itemPage");
		if (!pageIds.has(value.itemPage)) {
			throw new ValidationError(`Plugin ui.json searchProvider.itemPage references unknown page '${value.itemPage}'`);
		}
	}
}

function validateUiSlotContribution(
	slot: string,
	contribution: unknown,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): void {
	if (!isRecord(contribution)) throw new ValidationError(`Plugin ui.json slot '${slot}' entries must be objects`);

	assertLocalizedText(contribution.label, `ui.slots.${slot}.label`);
	if (contribution.icon !== undefined) assertNonEmptyString(contribution.icon, `ui.slots.${slot}.icon`);

	const hasAction = contribution.action !== undefined;
	const hasElement = contribution.element !== undefined;
	if (hasAction === hasElement) {
		throw new ValidationError(`Plugin ui.json slot '${slot}' entry must declare exactly one of action or element`);
	}

	if (hasAction) validateSlotAction(contribution.action, `ui.slots.${slot}.action`, pageIds, dialogIds);

	if (hasElement) validateUiSurface(contribution.element, `ui.slots.${slot}.element`);

	if (contribution.priority !== undefined && typeof contribution.priority !== "number") {
		throw new ValidationError(`Plugin ui.json slot '${slot}' priority must be a number`);
	}

	if (contribution.adminOnly !== undefined && typeof contribution.adminOnly !== "boolean") {
		throw new ValidationError(`Plugin ui.json slot '${slot}' adminOnly must be a boolean`);
	}

	if (contribution.iconOnly !== undefined && typeof contribution.iconOnly !== "boolean") {
		throw new ValidationError(`Plugin ui.json slot '${slot}' iconOnly must be a boolean`);
	}
}

function validateSlotAction(action: unknown, field: string, pageIds: ReadonlySet<string>, dialogIds: ReadonlySet<string>): void {
	if (!isRecord(action) || typeof action.type !== "string") throw new ValidationError(`Plugin ui.json ${field} must declare a type`);

	switch (action.type) {
		case "page":
			assertNonEmptyString(action.page, `${field}.page`);
			if (!pageIds.has(action.page)) throw new ValidationError(`Plugin ui.json ${field} references unknown page '${action.page}'`);

			assertOptionalStringRecord(action.params, `${field}.params`);

			return;
		case "dialog":
			assertNonEmptyString(action.dialog, `${field}.dialog`);
			if (!dialogIds.has(action.dialog)) throw new ValidationError(`Plugin ui.json ${field} references unknown dialog '${action.dialog}'`);

			assertOptionalStringRecord(action.params, `${field}.params`);

			return;
		case "navigate":
			assertSafeHref(action.href, `${field}.href`);

			return;
		case "external":
			assertSafeHref(action.href, `${field}.href`);

			return;
		default:
			throw new ValidationError(`Plugin ui.json ${field} has unsupported type '${action.type}'`);
	}
}

function validateUiSurface(surface: unknown, field: string): void {
	if (!isRecord(surface)) throw new ValidationError(`Plugin ui.json ${field} must be an object`);

	assertSurfaceTag(surface.tag, `${field}.tag`);
}

function assertSurfaceTag(tag: unknown, field: string): asserts tag is string {
	if (typeof tag !== "string" || !CUSTOM_ELEMENT_NAME_PATTERN.test(tag)) {
		throw new ValidationError(`Plugin ui.json ${field} must be a valid custom element tag (lowercase, hyphenated)`);
	}
}

/** A page/dialog renders either a custom element (`tag`) or a schema exactly once. */
function validateSurfaceDefinition(surface: Record<string, unknown>, field: string): void {
	const variants = [surface.tag !== undefined, surface.schema !== undefined, surface.schemaRef !== undefined].filter(Boolean).length;
	if (variants !== 1) {
		throw new ValidationError(`Plugin ui.json ${field} must declare exactly one of tag, schema or schemaRef`);
	}

	if (surface.tag !== undefined) assertSurfaceTag(surface.tag, `${field}.tag`);

	if (surface.schemaRef !== undefined) assertRelativeString(surface.schemaRef, `${field}.schemaRef`);

	if (surface.schema !== undefined) validatePluginSchema(surface.schema, `${field}.schema`);
}

/** Validates a declarative schema (used both for inline schemas and loaded schemaRef files). */
export function validatePluginSchema(value: unknown, field: string): asserts value is PluginUiSchemaSurface {
	if (!isRecord(value)) throw new ValidationError(`Plugin ui.json ${field} must be an object`);

	if (value.data !== undefined) {
		if (!isRecord(value.data)) throw new ValidationError(`Plugin ui.json ${field}.data must be an object`);

		const sources = Object.entries(value.data);
		if (sources.length > SCHEMA_MAX_SOURCES) throw new ValidationError(`Plugin ui.json ${field}.data has too many sources`);

		for (const [name, source] of sources) {
			if (!isRecord(source)) throw new ValidationError(`Plugin ui.json ${field}.data.${name} must be an object`);

			assertSafePluginSubPath(source.path, `${field}.data.${name}.path`);
		}
	}

	if (value.onMount !== undefined) {
		if (!Array.isArray(value.onMount)) throw new ValidationError(`Plugin ui.json ${field}.onMount must be an array`);

		for (const [index, action] of value.onMount.entries()) validateSchemaAction(action, `${field}.onMount[${index}]`);
	}

	const counter = { count: 0, fields: 0 };
	validateSchemaNodes(value.body, `${field}.body`, 0, counter);
}

function validateSchemaField(entry: Record<string, unknown>, fieldName: string): void {
	assertNonEmptyString(entry.name, `${fieldName}.name`);
	if (typeof entry.input !== "string" || !SCHEMA_FIELD_INPUTS.has(entry.input)) {
		throw new ValidationError(`Plugin ui.json ${fieldName}.input is unsupported`);
	}

	assertLocalizedText(entry.label, `${fieldName}.label`);
	if (entry.description !== undefined) assertLocalizedText(entry.description, `${fieldName}.description`);

	if (entry.placeholder !== undefined) assertLocalizedText(entry.placeholder, `${fieldName}.placeholder`);

	if (entry.required !== undefined && typeof entry.required !== "boolean") {
		throw new ValidationError(`Plugin ui.json ${fieldName}.required must be a boolean`);
	}

	if (entry.options !== undefined) {
		if (!Array.isArray(entry.options)) throw new ValidationError(`Plugin ui.json ${fieldName}.options must be an array`);

		for (const option of entry.options) {
			if (!isRecord(option)) throw new ValidationError(`Plugin ui.json ${fieldName}.options entries must be objects`);

			assertLocalizedText(option.label, `${fieldName}.options[].label`);
			if (typeof option.value !== "string" && typeof option.value !== "number") {
				throw new ValidationError(`Plugin ui.json ${fieldName}.options[].value must be a string or number`);
			}
		}
	}

	if (entry.hiddenIf !== undefined) validateSchemaCondition(entry.hiddenIf, `${fieldName}.hiddenIf`);
}

function validateSchemaNodes(nodes: unknown, field: string, depth: number, counter: { count: number; fields: number }): void {
	if (depth > SCHEMA_MAX_DEPTH) throw new ValidationError(`Plugin ui.json ${field} exceeds the maximum nesting depth`);

	if (!Array.isArray(nodes)) throw new ValidationError(`Plugin ui.json ${field} must be an array`);

	for (const node of nodes) validateSchemaNode(node, field, depth, counter);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: dispatches every schema node type
function validateSchemaNode(node: unknown, field: string, depth: number, counter: { count: number; fields: number }): void {
	counter.count += 1;
	if (counter.count > SCHEMA_MAX_NODES) throw new ValidationError(`Plugin ui.json ${field} exceeds the maximum node count`);

	if (!isRecord(node) || typeof node.type !== "string" || !SCHEMA_NODE_TYPES.has(node.type)) {
		throw new ValidationError(`Plugin ui.json ${field} has an unsupported node type`);
	}

	const nodeField = `${field}.${node.type}`;

	switch (node.type) {
		case "field":
			counter.fields += 1;
			if (counter.fields > SCHEMA_MAX_FIELDS) throw new ValidationError(`Plugin ui.json ${field} has too many fields`);

			validateSchemaField(node, nodeField);

			return;
		case "stack":
		case "card":
		case "section":
		case "row":
		case "grid":
			if (node.type === "card" || node.type === "section") {
				if (node.title !== undefined) assertLocalizedText(node.title, `${nodeField}.title`);

				if (node.description !== undefined) assertLocalizedText(node.description, `${nodeField}.description`);
			}

			validateSchemaNodes(node.children, `${nodeField}.children`, depth + 1, counter);

			return;
		case "tabs":
			if (!Array.isArray(node.tabs)) throw new ValidationError(`Plugin ui.json ${nodeField}.tabs must be an array`);

			for (const [index, tab] of node.tabs.entries()) {
				if (!isRecord(tab)) throw new ValidationError(`Plugin ui.json ${nodeField}.tabs[${index}] must be an object`);

				assertLocalizedText(tab.label, `${nodeField}.tabs[${index}].label`);
				validateSchemaNodes(tab.children, `${nodeField}.tabs[${index}].children`, depth + 1, counter);
			}

			return;
		case "separator":
		case "empty":
			return;
		case "heading":
		case "text":
		case "badge":
			assertLocalizedText(node.text, `${nodeField}.text`);

			return;
		case "alert":
			if (node.title !== undefined) assertLocalizedText(node.title, `${nodeField}.title`);

			if (node.description !== undefined) assertLocalizedText(node.description, `${nodeField}.description`);

			return;
		case "button":
			assertLocalizedText(node.label, `${nodeField}.label`);
			validateSchemaAction(node.action, `${nodeField}.action`);
			if (node.disabledIf !== undefined) validateSchemaCondition(node.disabledIf, `${nodeField}.disabledIf`);

			if (node.hiddenIf !== undefined) validateSchemaCondition(node.hiddenIf, `${nodeField}.hiddenIf`);

			return;
		case "stats":
			if (!Array.isArray(node.items)) throw new ValidationError(`Plugin ui.json ${nodeField}.items must be an array`);

			for (const item of node.items) {
				if (!isRecord(item)) throw new ValidationError(`Plugin ui.json ${nodeField}.items entries must be objects`);

				assertLocalizedText(item.label, `${nodeField}.items[].label`);
				assertNonEmptyString(item.value, `${nodeField}.items[].value`);
			}

			return;
		case "table":
			assertNonEmptyString(node.source, `${nodeField}.source`);
			if (!Array.isArray(node.columns)) throw new ValidationError(`Plugin ui.json ${nodeField}.columns must be an array`);

			for (const column of node.columns) {
				if (!isRecord(column)) throw new ValidationError(`Plugin ui.json ${nodeField}.columns entries must be objects`);

				assertLocalizedText(column.label, `${nodeField}.columns[].label`);
				assertNonEmptyString(column.value, `${nodeField}.columns[].value`);
			}

			if (node.rowActions !== undefined) validateSchemaNodes(node.rowActions, `${nodeField}.rowActions`, depth + 1, counter);

			return;
		case "list":
		case "foreach":
			assertNonEmptyString(node.source, `${nodeField}.source`);
			validateSchemaNodes(node.item, `${nodeField}.item`, depth + 1, counter);

			return;
		case "embed":
			assertSafeHref(node.src, `${nodeField}.src`);
			if (node.title !== undefined) assertLocalizedText(node.title, `${nodeField}.title`);

			return;
		case "if":
			validateSchemaCondition(node.condition, `${nodeField}.condition`);
			validateSchemaNodes(node.content, `${nodeField}.content`, depth + 1, counter);
			if (node.otherwise !== undefined) validateSchemaNodes(node.otherwise, `${nodeField}.otherwise`, depth + 1, counter);

			return;
		default:
			throw new ValidationError(`Plugin ui.json ${nodeField} has an unsupported node type`);
	}
}

function validateSchemaAction(action: unknown, field: string): void {
	if (!isRecord(action) || typeof action.type !== "string" || !SCHEMA_ACTION_TYPES.has(action.type)) {
		throw new ValidationError(`Plugin ui.json ${field} has an unsupported action type`);
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

			return;
		case "close":
			return;
		case "toast":
			if (action.level !== "success" && action.level !== "error" && action.level !== "info") {
				throw new ValidationError(`Plugin ui.json ${field}.level must be success, error or info`);
			}

			assertLocalizedText(action.message, `${field}.message`);

			return;
		case "refresh":
			assertOptionalStringArray(action.sources, `${field}.sources`);

			return;
		default:
			throw new ValidationError(`Plugin ui.json ${field} has an unsupported action type`);
	}
}

function validateSchemaCondition(condition: unknown, field: string): void {
	if (!isRecord(condition)) throw new ValidationError(`Plugin ui.json ${field} must be an object`);

	assertNonEmptyString(condition.left, `${field}.left`);
	if (typeof condition.op !== "string" || !SCHEMA_CONDITION_OPS.has(condition.op)) {
		throw new ValidationError(`Plugin ui.json ${field}.op is unsupported`);
	}
}

function assertOptionalStringArray(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw new ValidationError(`Plugin ui.json ${field} must be an array of strings`);
	}
}

function assertUiId(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (!PLUGIN_UI_ID_PATTERN.test(value)) throw new ValidationError(`Plugin ui.json ${field} has unsupported characters: ${value}`);
}

function assertLocalizedText(value: unknown, field: string): void {
	if (isNonEmptyString(value)) return;

	if (!isRecord(value)) throw new ValidationError(`Plugin ui.json ${field} must be a string or a locale map`);

	const entries = Object.entries(value);
	if (entries.length === 0) throw new ValidationError(`Plugin ui.json ${field} locale map must not be empty`);

	for (const [locale, text] of entries) {
		if (!(isNonEmptyString(locale) && isNonEmptyString(text))) {
			throw new ValidationError(`Plugin ui.json ${field} locale map values must be non-empty strings`);
		}
	}
}

function assertOptionalStringRecord(value: unknown, field: string): void {
	if (value === undefined) return;

	if (!isRecord(value) || Object.values(value).some((item) => !isNonEmptyString(item))) {
		throw new ValidationError(`Plugin ui.json ${field} must be a map of non-empty strings`);
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
		throw new ValidationError(`Plugin ui.json ${field} must not be protocol-relative`);
	}

	if (value.startsWith("/")) return;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new ValidationError(`Plugin ui.json ${field} must be an absolute http(s) URL or a site-relative path`);
	}

	if (!ALLOWED_HREF_PROTOCOLS.has(parsed.protocol)) {
		throw new ValidationError(`Plugin ui.json ${field} uses an unsupported URL scheme: ${parsed.protocol}`);
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
		throw new ValidationError(`Plugin ui.json ${field} must be a relative plugin path without traversal or query`);
	}
}

export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
	const manifestPath = PathUtils.join(pluginDir, "plugin.json");
	const manifest = await FileUtils.readJson<unknown>(manifestPath);
	if (!manifest) throw new ValidationError(`Plugin is missing a valid plugin.json: ${manifestPath}`);

	validatePluginManifest(manifest);

	return manifest;
}

export function resolvePluginEntry(pluginDir: string, manifest: PluginManifest): string {
	return resolvePluginPath(pluginDir, manifest.entry, "entry");
}

/** Loads a `schemaRef` file, validates it and returns the schema surface. */
async function loadResolvedSchema(pluginDir: string, ref: string, field: string): Promise<PluginUiSchemaSurface> {
	const refPath = resolvePluginPath(pluginDir, ref, `${field}.schemaRef`);
	const raw = await FileUtils.readJson<unknown>(refPath, { maxSize: SCHEMA_MAX_BYTES });
	if (raw === null) throw new ValidationError(`Plugin ui.json ${field}.schemaRef is missing or unreadable: ${ref}`);

	validatePluginSchema(raw, `${field}.schema`);

	return raw;
}

/**
 * Inlines every `schemaRef` into the manifest so the client receives renderable
 * schemas in the aggregated UI manifest (no extra fetch, role filtering applies).
 */
export async function resolvePluginUiSchemas(pluginDir: string, manifest: PluginUiManifest): Promise<PluginUiManifest> {
	const pages = manifest.pages
		? await Promise.all(
				manifest.pages.map(async (page, index) => {
					if (!page.schemaRef) return page;

					const schema = await loadResolvedSchema(pluginDir, page.schemaRef, `ui.pages[${index}]`);

					return { ...page, schema, schemaRef: undefined };
				}),
			)
		: undefined;

	const dialogs = manifest.dialogs
		? await Promise.all(
				manifest.dialogs.map(async (dialog, index) => {
					if (!dialog.schemaRef) return dialog;

					const schema = await loadResolvedSchema(pluginDir, dialog.schemaRef, `ui.dialogs[${index}]`);

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
		throw new ValidationError(`Plugin uses capabilities missing from plugin.json: ${missing.join(", ")}`);
	}
}

export function validatePluginConfig(config: unknown, definition?: ConfigDefinition): PluginConfig {
	const validated = definition ? definition.parse(config) : config;
	if (!isRecord(validated)) throw new ValidationError("Plugin configuration must be an object");

	return validated;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
	if (!isNonEmptyString(value)) throw new ValidationError(`Plugin manifest ${field} must be a non-empty string`);
}

function assertRelativeString(value: unknown, field: string): asserts value is string {
	assertNonEmptyString(value, field);
	if (PathUtils.isAbsolute(value) || !value.startsWith("./")) {
		throw new ValidationError(`Plugin manifest ${field} must be a relative path starting with './'`);
	}
}

function resolvePluginPath(pluginDir: string, path: string, field: string): string {
	const root = PathUtils.resolve(pluginDir);
	const resolvedPath = PathUtils.resolve(root, path);
	if (!PathUtils.isSubpath(resolvedPath, root)) {
		throw new ValidationError(`Plugin manifest ${field} escapes plugin directory: ${path}`);
	}

	return resolvedPath;
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) {
		throw new ValidationError(`Plugin manifest ${field} must be an array of non-empty strings`);
	}
}

function assertUnique(values: string[], field: string): void {
	if (new Set(values).size !== values.length) throw new ValidationError(`Plugin manifest ${field} must not contain duplicates`);
}
