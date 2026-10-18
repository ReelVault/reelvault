import type { PluginUiSurfaceKind } from "@reelvault/sdk/common";
import type {
	PluginLocalizedText,
	PluginSlotContribution,
	PluginSlotName,
	PluginTabContribution,
	PluginTabHostName,
	PluginUiManifest,
} from "@reelvault/sdk/plugin";
import { PLUGIN_SLOT_NAMES, PLUGIN_TAB_HOST_NAMES } from "@reelvault/sdk/plugin";

/** Override key that hides a plugin's whole UI. */
export const PLUGIN_UI_MASTER_KEY = "*";

export interface PluginUiContributionInfo {
	key: string;
	surface: PluginUiSurfaceKind;
	label: string;
	adminOnly: boolean;
}

function labelOf(text: PluginLocalizedText | undefined, fallback: string): string {
	if (typeof text === "string") return text;

	return text ? (Object.values(text)[0] ?? fallback) : fallback;
}

function slotDescriptor(contribution: PluginSlotContribution): string {
	const action = contribution.action;
	if (action?.type === "page") return `page:${action.page}`;

	if (action?.type === "dialog") return `dialog:${action.dialog}`;

	if (action) return `${action.type}:${action.href}`;

	return contribution.element ? `element:${contribution.element.tag}` : "unknown";
}

/**
 * Stable key of every slot contribution of a manifest, in declaration order.
 * An entry with an `id` is keyed by it. Otherwise the key is derived from what
 * the entry does, and a second entry that does the same thing gets a `#n` suffix.
 */
function slotKeys(slot: PluginSlotName, contributions: readonly PluginSlotContribution[]): string[] {
	const seen = new Map<string, number>();

	return contributions.map((contribution) => {
		const base = contribution.id !== undefined ? `slot:${slot}:id:${contribution.id}` : `slot:${slot}:${slotDescriptor(contribution)}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);

		return count === 1 ? base : `${base}#${count}`;
	});
}

function tabKey(tab: PluginTabContribution): string {
	return `tab:${tab.host}:${tab.id}`;
}

/** Every switchable piece of a plugin's UI, with its stable override key. */
export function listUiContributions(manifest: PluginUiManifest): PluginUiContributionInfo[] {
	const result: PluginUiContributionInfo[] = [];
	for (const page of manifest.pages ?? []) {
		result.push({ key: `page:${page.id}`, surface: "page", label: labelOf(page.name, page.id), adminOnly: page.adminOnly === true });
	}

	for (const dialog of manifest.dialogs ?? []) {
		result.push({
			key: `dialog:${dialog.id}`,
			surface: "dialog",
			label: labelOf(dialog.title, dialog.id),
			adminOnly: dialog.adminOnly === true,
		});
	}

	for (const host of PLUGIN_TAB_HOST_NAMES) {
		for (const tab of manifest.tabs?.[host] ?? []) {
			result.push({ key: tabKey(tab), surface: "tab", label: labelOf(tab.label, tab.id), adminOnly: tab.adminOnly === true });
		}
	}

	for (const slot of PLUGIN_SLOT_NAMES) {
		const contributions = manifest.slots?.[slot] ?? [];
		const keys = slotKeys(slot, contributions);
		for (const [index, contribution] of contributions.entries()) {
			const key = keys[index] ?? `slot:${slot}:${index}`;
			result.push({ key, surface: "slot", label: labelOf(contribution.label, key), adminOnly: contribution.adminOnly === true });
		}
	}

	if (manifest.searchProvider) {
		result.push({ key: "searchProvider", surface: "searchProvider", label: "searchProvider", adminOnly: false });
	}

	if (manifest.playbackPreRoll) {
		result.push({ key: "playbackPreRoll", surface: "playbackPreRoll", label: "playbackPreRoll", adminOnly: false });
	}

	return result;
}

/**
 * Removes the contributions listed in `hiddenKeys` together with everything
 * that would dangle without them: tabs and slot actions pointing at a hidden
 * page or dialog, and a search provider's `itemPage`.
 */
export function applyUiOverrides(manifest: PluginUiManifest, hiddenKeys: ReadonlySet<string>): PluginUiManifest {
	if (hiddenKeys.size === 0) return manifest;

	const pages = manifest.pages?.filter((page) => !hiddenKeys.has(`page:${page.id}`));
	const dialogs = manifest.dialogs?.filter((dialog) => !hiddenKeys.has(`dialog:${dialog.id}`));
	const pageIds = new Set((pages ?? []).map((page) => page.id));
	const dialogIds = new Set((dialogs ?? []).map((dialog) => dialog.id));

	const result: PluginUiManifest = { ...manifest };
	if (pages) result.pages = pages;

	if (dialogs) result.dialogs = dialogs;

	if (manifest.tabs) {
		const tabs: Partial<Record<PluginTabHostName, PluginTabContribution[]>> = {};
		for (const host of PLUGIN_TAB_HOST_NAMES) {
			const contributions = manifest.tabs[host];
			if (contributions) tabs[host] = contributions.filter((tab) => !hiddenKeys.has(tabKey(tab)) && pageIds.has(tab.page));
		}

		result.tabs = tabs;
	}

	if (manifest.slots) {
		const slots: Partial<Record<PluginSlotName, PluginSlotContribution[]>> = {};
		for (const slot of PLUGIN_SLOT_NAMES) {
			const contributions = manifest.slots[slot];
			if (!contributions) continue;

			const keys = slotKeys(slot, contributions);
			slots[slot] = contributions.filter((contribution, index) => {
				if (hiddenKeys.has(keys[index] ?? "")) return false;

				const action = contribution.action;
				if (action?.type === "page") return pageIds.has(action.page);

				return action?.type === "dialog" ? dialogIds.has(action.dialog) : true;
			});
		}

		result.slots = slots;
	}

	if (hiddenKeys.has("searchProvider")) result.searchProvider = undefined;
	else if (result.searchProvider?.itemPage && !pageIds.has(result.searchProvider.itemPage)) {
		result.searchProvider = { ...result.searchProvider, itemPage: undefined };
	}

	if (hiddenKeys.has("playbackPreRoll")) result.playbackPreRoll = undefined;

	return result;
}
