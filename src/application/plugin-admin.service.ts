import type { PluginAdminStatus } from "@reelvault/sdk/common";
import type { PluginStatus } from "@reelvault/sdk/plugin";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";

/**
 * Admin use cases over the plugin lifecycle. Mutations swallow the failure and
 * return the recorded post-action status: pluginManager persists the error
 * state on the plugin itself, which the admin UI renders.
 */
async function withAdminDetails(status: PluginStatus): Promise<PluginAdminStatus> {
	const configReadError = await pluginManager.getConfigReadError(status.id);

	return { ...status, ...(configReadError ? { configReadError } : {}) };
}

async function findAdminStatus(pluginId: string): Promise<PluginAdminStatus | undefined> {
	const status = pluginManager.getStatus().find((plugin) => plugin.id === pluginId);

	return status ? await withAdminDetails(status) : undefined;
}

export const pluginAdminService = {
	async list(): Promise<PluginAdminStatus[]> {
		return await Promise.all(pluginManager.getStatus().map((status) => withAdminDetails(status)));
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
