import type { PluginAdminStatus } from "@reelvault/sdk/common";
import type { PluginStatus } from "@reelvault/sdk/plugin";
import { pluginCatalogService } from "@/plugins/catalog/plugin-catalog.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";

/**
 * Admin use cases over the plugin lifecycle. Mutations swallow the failure and
 * return the recorded post-action status: pluginManager persists the error
 * state on the plugin itself, which the admin UI renders.
 */
async function withAdminDetails(status: PluginStatus, updatable: ReadonlySet<string>): Promise<PluginAdminStatus> {
	const details = await pluginManager.getPackageDetails(status.id);

	return { ...status, ...details, updateAvailable: updatable.has(status.id) };
}

async function findAdminStatus(pluginId: string): Promise<PluginAdminStatus | undefined> {
	const status = pluginManager.getStatus().find((plugin) => plugin.id === pluginId);
	if (!status) return undefined;

	return await withAdminDetails(status, await pluginCatalogService.updatablePluginIds());
}

/** Applies a lifecycle change, then reports the state the manager recorded even when the change failed. */
async function applyAndReadStatus(pluginId: string, apply: () => Promise<void>): Promise<PluginAdminStatus | undefined> {
	try {
		await apply();
	} catch {
		// pluginManager records the failure on the plugin state returned below.
	}

	return await findAdminStatus(pluginId);
}

export const pluginAdminService = {
	async list(): Promise<PluginAdminStatus[]> {
		const updatable = await pluginCatalogService.updatablePluginIds();

		return await Promise.all(pluginManager.getStatus().map((status) => withAdminDetails(status, updatable)));
	},

	get(pluginId: string): Promise<PluginAdminStatus | undefined> {
		return findAdminStatus(pluginId);
	},

	async reload(pluginId: string): Promise<PluginAdminStatus | undefined> {
		return await applyAndReadStatus(pluginId, async () => await pluginManager.reload(pluginId));
	},

	async enable(pluginId: string): Promise<PluginAdminStatus | undefined> {
		return await applyAndReadStatus(pluginId, async () => await pluginManager.setEnabled(pluginId, true));
	},

	async disable(pluginId: string): Promise<PluginAdminStatus | undefined> {
		return await applyAndReadStatus(pluginId, async () => await pluginManager.setEnabled(pluginId, false));
	},
};
