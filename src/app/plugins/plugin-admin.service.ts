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

export const pluginAdminService = {
	async list(): Promise<PluginAdminStatus[]> {
		const updatable = await pluginCatalogService.updatablePluginIds();

		return await Promise.all(pluginManager.getStatus().map((status) => withAdminDetails(status, updatable)));
	},

	get(pluginId: string): Promise<PluginAdminStatus | undefined> {
		return findAdminStatus(pluginId);
	},

	async reload(pluginId: string): Promise<PluginAdminStatus | undefined> {
		try {
			await pluginManager.reload(pluginId);
		} catch {
			// Reloading may fail again; the recorded state is returned below.
		}

		return await findAdminStatus(pluginId);
	},

	async enable(pluginId: string): Promise<PluginAdminStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, true);
		} catch {
			// Enabling may fail; the recorded state is returned below.
		}

		return await findAdminStatus(pluginId);
	},

	async disable(pluginId: string): Promise<PluginAdminStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, false);
		} catch {
			// Disabling may fail; the recorded state is returned below.
		}

		return await findAdminStatus(pluginId);
	},
};
