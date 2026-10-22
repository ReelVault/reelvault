import {
	PLUGIN_DIALOG_SIZES as PLUGIN_DIALOG_SIZE_VALUES,
	PLUGIN_SLOT_NAMES as PLUGIN_SLOT_NAME_VALUES,
	PLUGIN_TAB_HOST_NAMES as PLUGIN_TAB_HOST_NAME_VALUES,
	type PluginUiManifest,
} from "@reelvault/sdk/plugin";
import { DomainError } from "@/utils/domain.errors";
import { isNonEmptyString, isRecord } from "@/utils/type.utils";
import {
	assertLocalizedText,
	assertNonEmptyString,
	assertOptionalStringRecord,
	assertOptionalType,
	assertRelativeString,
	assertSafeHref,
	assertUiId,
	optionalUiId,
} from "./manifest-fields.validator";
import { validatePlaybackPreRoll, validateSearchProvider } from "./providers.validator";
import { validatePluginSchema } from "./schema.validator";

const PLUGIN_SLOT_NAMES: ReadonlySet<string> = new Set(PLUGIN_SLOT_NAME_VALUES);

const PLUGIN_TAB_HOST_NAMES: ReadonlySet<string> = new Set(PLUGIN_TAB_HOST_NAME_VALUES);

const PLUGIN_DIALOG_SIZES: ReadonlySet<string> = new Set(PLUGIN_DIALOG_SIZE_VALUES);

/** Page paths are single URL segments mounted under `/plugins/<id>/page/`. */
const PLUGIN_UI_PAGE_PATH_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Custom element names must contain a hyphen and be lowercase (WHATWG custom elements spec). */
const CUSTOM_ELEMENT_NAME_PATTERN = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

export function validatePluginUiManifest(value: unknown): asserts value is PluginUiManifest {
	if (!isRecord(value)) throw new DomainError("validation", "Plugin ui.json must be an object", { code: "plugin.ui.manifest_not_object" });

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

/** A UI surface entry whose id has been validated. */
type UiSurfaceEntry = Record<string, unknown> & { id: string };

/**
 * The entries of a UI surface list, checked for shape and unique ids. The
 * page- and dialog-specific rules run on the returned entries.
 */
function validatedUiSurfaces(entries: unknown, field: "pages" | "dialogs"): { ids: Set<string>; entries: UiSurfaceEntry[] } {
	const ids = new Set<string>();
	if (entries === undefined) return { ids, entries: [] };

	if (!Array.isArray(entries))
		throw new DomainError("validation", `Plugin ui.json ${field} must be an array`, {
			code: "plugin.ui.field_not_array",
			params: { field },
		});

	const validated: UiSurfaceEntry[] = [];
	for (const entry of entries) {
		if (!isRecord(entry))
			throw new DomainError("validation", `Plugin ui.json ${field} entries must be objects`, {
				code: "plugin.ui.entry_not_object",
				params: { field },
			});

		assertUiId(entry.id, `ui.${field}[].id`);
		if (ids.has(entry.id))
			throw new DomainError("validation", `Plugin ui.json has duplicate ${field.slice(0, -1)} id '${entry.id}'`, {
				code: "plugin.ui.duplicate_id",
				params: { field, id: entry.id },
			});

		ids.add(entry.id);
		validated.push({ ...entry, id: entry.id });
	}

	return { ids, entries: validated };
}

function validateUiPages(pages: unknown, dialogIds: ReadonlySet<string>): Set<string> {
	const { ids, entries } = validatedUiSurfaces(pages, "pages");

	for (const page of entries) {
		const id = page.id;
		if (typeof page.path !== "string" || !PLUGIN_UI_PAGE_PATH_PATTERN.test(page.path)) {
			throw new DomainError("validation", `Plugin ui.json page '${id}' has an invalid path`, {
				code: "plugin.ui.page_path_invalid",
				params: { page: id },
			});
		}

		assertLocalizedText(page.name, `ui.pages.${id}.name`);
		if (page.icon !== undefined) assertNonEmptyString(page.icon, `ui.pages.${id}.icon`);

		validateSurfaceDefinition(page, `ui.pages.${id}`, dialogIds);
		assertOptionalType(page.adminOnly, "boolean", `page '${id}' adminOnly`);

		if (page.nav !== undefined && page.nav !== false && page.nav !== "user" && page.nav !== "admin") {
			throw new DomainError("validation", `Plugin ui.json page '${id}' nav must be 'user', 'admin' or false`, {
				code: "plugin.ui.page_nav_invalid",
				params: { page: id },
			});
		}

		assertOptionalType(page.priority, "number", `page '${id}' priority`);
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
	const { ids, entries } = validatedUiSurfaces(dialogs, "dialogs");

	for (const dialog of entries) {
		const id = dialog.id;
		assertLocalizedText(dialog.title, `ui.dialogs.${id}.title`);
		if (dialog.icon !== undefined) assertNonEmptyString(dialog.icon, `ui.dialogs.${id}.icon`);

		if (dialog.size !== undefined && (typeof dialog.size !== "string" || !PLUGIN_DIALOG_SIZES.has(dialog.size))) {
			throw new DomainError("validation", `Plugin ui.json dialog '${id}' has an unsupported size`, {
				code: "plugin.ui.dialog_size_invalid",
				params: { dialog: id },
			});
		}

		validateSurfaceDefinition(dialog, `ui.dialogs.${id}`, dialogIds);
		assertOptionalType(dialog.adminOnly, "boolean", `dialog '${id}' adminOnly`);
	}

	return ids;
}

function validateUiTabs(tabs: unknown, pageIds: ReadonlySet<string>): void {
	if (!isRecord(tabs))
		throw new DomainError("validation", "Plugin ui.json tabs must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "tabs" },
		});

	for (const [host, contributions] of Object.entries(tabs)) {
		if (!PLUGIN_TAB_HOST_NAMES.has(host)) {
			throw new DomainError("validation", `Plugin ui.json has unsupported tab host '${host}'`, {
				code: "plugin.ui.tab_host_unsupported",
				params: { host },
			});
		}

		if (!Array.isArray(contributions))
			throw new DomainError("validation", `Plugin ui.json tab host '${host}' must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `tabs.${host}` },
			});

		for (const tab of contributions) {
			if (!isRecord(tab))
				throw new DomainError("validation", `Plugin ui.json tab host '${host}' entries must be objects`, {
					code: "plugin.ui.entry_not_object",
					params: { field: `tabs.${host}` },
				});

			assertUiId(tab.id, `ui.tabs.${host}[].id`);
			if (tab.host !== host)
				throw new DomainError("validation", `Plugin ui.json tab '${tab.id}' host must match its group '${host}'`, {
					code: "plugin.ui.tab_host_mismatch",
					params: { tab: tab.id, host },
				});

			assertLocalizedText(tab.label, `ui.tabs.${host}.${tab.id}.label`);
			if (tab.icon !== undefined) assertNonEmptyString(tab.icon, `ui.tabs.${host}.${tab.id}.icon`);

			assertNonEmptyString(tab.page, `ui.tabs.${host}.${tab.id}.page`);
			if (!pageIds.has(tab.page))
				throw new DomainError("validation", `Plugin ui.json tab '${tab.id}' references unknown page '${tab.page}'`, {
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
		throw new DomainError("validation", "Plugin ui.json slots must be an object", {
			code: "plugin.ui.field_not_object",
			params: { field: "slots" },
		});

	for (const [slot, contributions] of Object.entries(slots)) {
		if (!PLUGIN_SLOT_NAMES.has(slot)) {
			throw new DomainError("validation", `Plugin ui.json has unsupported slot '${slot}'`, {
				code: "plugin.ui.slot_unsupported",
				params: { slot },
			});
		}

		if (!Array.isArray(contributions))
			throw new DomainError("validation", `Plugin ui.json slot '${slot}' must be an array`, {
				code: "plugin.ui.field_not_array",
				params: { field: `slots.${slot}` },
			});

		const ids = new Set<string>();
		for (const contribution of contributions) {
			const id = validateUiSlotContribution(slot, contribution, pageIds, dialogIds);
			if (id === undefined) continue;

			if (ids.has(id))
				throw new DomainError("validation", `Plugin ui.json slot '${slot}' declares the id '${id}' twice`, {
					code: "plugin.ui.duplicate_id",
					params: { field: `slots.${slot}`, id },
				});
			ids.add(id);
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
		throw new DomainError("validation", `Plugin ui.json slot '${slot}' entries must be objects`, {
			code: "plugin.ui.entry_not_object",
			params: { field: `slots.${slot}` },
		});

	const id = optionalUiId(contribution.id, `ui.slots.${slot}.id`);
	assertLocalizedText(contribution.label, `ui.slots.${slot}.label`);
	if (contribution.icon !== undefined) assertNonEmptyString(contribution.icon, `ui.slots.${slot}.icon`);

	const hasAction = contribution.action !== undefined;
	const hasElement = contribution.element !== undefined;
	if (hasAction === hasElement) {
		throw new DomainError("validation", `Plugin ui.json slot '${slot}' entry must declare exactly one of action or element`, {
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
		throw new DomainError("validation", `Plugin ui.json ${field} must declare a type`, {
			code: "plugin.ui.action_type_missing",
			params: { field },
		});

	switch (action.type) {
		case "page":
			assertNonEmptyString(action.page, `${field}.page`);
			if (!pageIds.has(action.page))
				throw new DomainError("validation", `Plugin ui.json ${field} references unknown page '${action.page}'`, {
					code: "plugin.ui.page_unknown",
					params: { page: action.page },
				});

			assertOptionalStringRecord(action.params, `${field}.params`);

			return;
		case "dialog":
			assertNonEmptyString(action.dialog, `${field}.dialog`);
			if (!dialogIds.has(action.dialog))
				throw new DomainError("validation", `Plugin ui.json ${field} references unknown dialog '${action.dialog}'`, {
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
			throw new DomainError("validation", `Plugin ui.json ${field} has unsupported type '${action.type}'`, {
				code: "plugin.ui.action_type_unsupported",
				params: { field, type: action.type },
			});
	}
}

function validateUiSurface(surface: unknown, field: string): void {
	if (!isRecord(surface))
		throw new DomainError("validation", `Plugin ui.json ${field} must be an object`, {
			code: "plugin.ui.field_not_object",
			params: { field },
		});

	assertSurfaceTag(surface.tag, `${field}.tag`);
}

function assertSurfaceTag(tag: unknown, field: string): asserts tag is string {
	if (typeof tag !== "string" || !CUSTOM_ELEMENT_NAME_PATTERN.test(tag)) {
		throw new DomainError("validation", `Plugin ui.json ${field} must be a valid custom element tag (lowercase, hyphenated)`, {
			code: "plugin.ui.element_tag_invalid",
			params: { field },
		});
	}
}

/** A page/dialog renders either a custom element (`tag`) or a schema exactly once. */
function validateSurfaceDefinition(surface: Record<string, unknown>, field: string, dialogIds: ReadonlySet<string>): void {
	const variants = [surface.tag !== undefined, surface.schema !== undefined, surface.schemaRef !== undefined].filter(Boolean).length;
	if (variants !== 1) {
		throw new DomainError("validation", `Plugin ui.json ${field} must declare exactly one of tag, schema or schemaRef`, {
			code: "plugin.ui.element_source_invalid",
			params: { field },
		});
	}

	if (surface.tag !== undefined) assertSurfaceTag(surface.tag, `${field}.tag`);

	if (surface.schemaRef !== undefined) assertRelativeString(surface.schemaRef, `${field}.schemaRef`);

	if (surface.schema !== undefined) validatePluginSchema(surface.schema, `${field}.schema`, dialogIds);
}
