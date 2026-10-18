import type {
	PluginSlotContribution,
	PluginSlotName,
	PluginTabContribution,
	PluginTabHostName,
	PluginUiManifest,
} from "@reelvault/sdk/plugin";
import { PLUGIN_SLOT_NAMES, PLUGIN_TAB_HOST_NAMES } from "@reelvault/sdk/plugin";

/** Pure UI-manifest helpers: role filtering and custom-element tag collection. */

/**
 * Drops admin-only surfaces from a manifest for non-admin callers, together
 * with the tabs and slot actions that reference them. Keeping this in one place
 * guarantees the host never receives a contribution pointing at a hidden page.
 */
export function filterUiManifestForRole(manifest: PluginUiManifest): PluginUiManifest {
	const pages = manifest.pages?.filter((page) => !page.adminOnly);
	const pageIds = new Set((pages ?? []).map((page) => page.id));
	const dialogs = manifest.dialogs?.filter((dialog) => !dialog.adminOnly);
	const dialogIds = new Set((dialogs ?? []).map((dialog) => dialog.id));

	return {
		...manifest,
		...(manifest.pages ? { pages } : {}),
		...(manifest.dialogs ? { dialogs } : {}),
		...(manifest.tabs ? { tabs: filterTabsForRole(manifest.tabs, pageIds) } : {}),
		...(manifest.slots ? { slots: filterSlotsForRole(manifest.slots, pageIds, dialogIds) } : {}),
	};
}

function filterTabsForRole(
	tabs: Partial<Record<PluginTabHostName, PluginTabContribution[]>>,
	pageIds: ReadonlySet<string>,
): Partial<Record<PluginTabHostName, PluginTabContribution[]>> {
	return filterByKey(tabs, PLUGIN_TAB_HOST_NAMES, (tab) => !tab.adminOnly && pageIds.has(tab.page));
}

function filterSlotsForRole(
	slots: Partial<Record<PluginSlotName, PluginSlotContribution[]>>,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): Partial<Record<PluginSlotName, PluginSlotContribution[]>> {
	return filterByKey(slots, PLUGIN_SLOT_NAMES, (contribution) => slotContributionIsVisible(contribution, pageIds, dialogIds));
}

/** Keeps the entries under each known key that pass `keep`; keys with no entries stay absent. */
function filterByKey<K extends string, T>(
	record: Partial<Record<K, T[]>>,
	keys: readonly K[],
	keep: (item: T) => boolean,
): Partial<Record<K, T[]>> {
	const result: Partial<Record<K, T[]>> = {};
	for (const key of keys) {
		const items = record[key];
		if (items) result[key] = items.filter((item) => keep(item));
	}

	return result;
}

function slotContributionIsVisible(
	contribution: PluginSlotContribution,
	pageIds: ReadonlySet<string>,
	dialogIds: ReadonlySet<string>,
): boolean {
	if (contribution.adminOnly) return false;

	const action = contribution.action;
	if (!action) return true;

	if (action.type === "page") return pageIds.has(action.page);

	if (action.type === "dialog") return dialogIds.has(action.dialog);

	return true;
}

/** Every custom element tag a plugin UI manifest registers. */
export function collectUiManifestTags(manifest: PluginUiManifest): Set<string> {
	const tags = new Set<string>();
	for (const page of manifest.pages ?? []) {
		if (page.tag) tags.add(page.tag);
	}

	for (const dialog of manifest.dialogs ?? []) {
		if (dialog.tag) tags.add(dialog.tag);
	}

	for (const contributions of Object.values(manifest.slots ?? {})) {
		for (const contribution of contributions) {
			if (contribution.element?.tag) tags.add(contribution.element.tag);
		}
	}

	return tags;
}
