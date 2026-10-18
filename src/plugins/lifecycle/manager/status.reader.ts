import type { PluginStatus } from "@reelvault/sdk/plugin";
import type { PluginManagerState } from "./state.utils";

function byStatusName(a: PluginStatus, b: PluginStatus): number {
	return a.name.localeCompare(b.name);
}

/** Working plugins first, then disabled, failed ones trailing — alphabetical within each group. */
export function getStatus(state: PluginManagerState): PluginStatus[] {
	const loaded = [...state.registry.getStatuses()].toSorted(byStatusName);
	const loadedIds = new Set(loaded.map((status) => status.id));
	const disabled = [...state.disabledStatuses.values()].filter((status) => !loadedIds.has(status.id)).toSorted(byStatusName);
	const failed = [...state.registry.getFailedStatuses()].toSorted(byStatusName);

	return [...loaded, ...disabled, ...failed];
}
