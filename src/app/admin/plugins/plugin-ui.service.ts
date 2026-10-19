import type { PluginUiSettings, UpdatePluginUiSettingsBody } from "@reelvault/sdk/common";
import { auditedChange } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import type { AdminServiceState } from "../shared.utils";

/** Compact audit view of a plugin's UI switches: master flag plus the hidden keys. */
function summarizeUiSettings(settings: PluginUiSettings): { enabled: boolean; disabledKeys: string[] } {
	return { enabled: settings.enabled, disabledKeys: settings.contributions.filter((item) => !item.enabled).map((item) => item.key) };
}

export function getPluginUiSettings(pluginId: string): Promise<PluginUiSettings> {
	return pluginUiSettingsService.get(pluginId);
}

export async function updatePluginUiSettings(
	state: AdminServiceState,
	pluginId: string,
	body: UpdatePluginUiSettingsBody,
	context?: AdminAuditContext,
): Promise<PluginUiSettings> {
	const before = await pluginUiSettingsService.get(pluginId);

	return await auditedChange({
		logger: state.logger,
		resourceType: "plugin_ui_settings",
		resourceId: pluginId,
		before: summarizeUiSettings(before),
		change: async () => await pluginUiSettingsService.update(pluginId, body),
		after: summarizeUiSettings,
		context,
	});
}

export async function resetPluginUiSettings(
	state: AdminServiceState,
	pluginId: string,
	context?: AdminAuditContext,
): Promise<PluginUiSettings> {
	const before = await pluginUiSettingsService.get(pluginId);

	return await auditedChange({
		logger: state.logger,
		resourceType: "plugin_ui_settings",
		resourceId: pluginId,
		before: summarizeUiSettings(before),
		change: async () => {
			await pluginUiSettingsService.reset(pluginId);

			return await pluginUiSettingsService.get(pluginId);
		},
		after: summarizeUiSettings,
		context,
	});
}
