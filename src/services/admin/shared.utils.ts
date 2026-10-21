import type { Logger, PluginAdminStatus } from "@reelvault/sdk/common";
import { DomainError } from "@/utils/domain.errors";

/** What the admin functions need from their facade: a name for error reports and a logger. */
export interface AdminServiceState {
	readonly serviceName: string;
	readonly logger: Logger;
}

/** The plugin's status, or the not-found error every plugin action reports when the plugin is not loaded. */
export function requirePlugin(plugin: PluginAdminStatus | null | undefined, pluginId: string): PluginAdminStatus {
	if (!plugin) throw new DomainError("not_found", `Plugin not found: ${pluginId}`, { code: "plugin.not_found" });

	return plugin;
}
