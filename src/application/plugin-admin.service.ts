import type { PluginStatus } from "@reelvault/sdk/plugin";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";

/**
 * Admin use cases over the plugin lifecycle. Mutations swallow the failure and
 * return the recorded post-action status: pluginManager persists the error
 * state on the plugin itself, which the admin UI renders.
 */
export const pluginAdminService = {
	get(pluginId: string): PluginStatus | undefined {
		return pluginManager.getStatus().find((plugin) => plugin.id === pluginId);
	},

	async reload(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.reload(pluginId);
		} catch {
			// Reloading may fail again; the recorded state is returned below.
		}

		return pluginAdminService.get(pluginId);
	},

	async enable(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, true);
		} catch {
			// Enabling may fail; the recorded state is returned below.
		}

		return pluginAdminService.get(pluginId);
	},

	async disable(pluginId: string): Promise<PluginStatus | undefined> {
		try {
			await pluginManager.setEnabled(pluginId, false);
		} catch {
			// Disabling may fail; the recorded state is returned below.
		}

		return pluginAdminService.get(pluginId);
	},
};
