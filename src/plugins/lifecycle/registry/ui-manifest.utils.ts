import type { PluginUiManifest } from "@reelvault/sdk/plugin";
import { filterUiManifest } from "@/plugins/lifecycle/plugin-ui-contributions.utils";

/** Pure UI-manifest helpers: role filtering and custom-element tag collection. */

/**
 * Drops admin-only surfaces from a manifest for non-admin callers, together
 * with the tabs and slot actions that reference them. Keeping this in one place
 * guarantees the host never receives a contribution pointing at a hidden page.
 */
export function filterUiManifestForRole(manifest: PluginUiManifest): PluginUiManifest {
	return filterUiManifest(manifest, {
		keepPage: (page) => !page.adminOnly,
		keepDialog: (dialog) => !dialog.adminOnly,
		keepTab: (tab) => !tab.adminOnly,
		keepSlot: (contribution) => !contribution.adminOnly,
	});
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
