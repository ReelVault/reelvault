import type { PluginUiSettings, UpdatePluginUiSettingsBody } from "@reelvault/sdk/common";
import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import { adminLog } from "@/services/admin/admin.logger";
import { auditedChange } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";

/** Compact audit view of a plugin's UI switches: master flag plus the hidden keys. */
function summarizeUiSettings(settings: PluginUiSettings): { enabled: boolean; disabledKeys: string[] } {
	return { enabled: settings.enabled, disabledKeys: settings.contributions.filter((item) => !item.enabled).map((item) => item.key) };
}

export function getPluginUiSettings(pluginId: string): Promise<PluginUiSettings> {
	return pluginUiSettingsService.get(pluginId);
}

/** Runs one UI-settings change and audits its compact summary before and after. */
async function changeUiSettings(
	pluginId: string,
	context: AdminAuditContext | undefined,
	change: () => Promise<PluginUiSettings>,
): Promise<PluginUiSettings> {
	const before = await pluginUiSettingsService.get(pluginId);

	return await auditedChange({
		logger: adminLog.logger,
		resourceType: "plugin_ui_settings",
		resourceId: pluginId,
		before: summarizeUiSettings(before),
		change,
		after: summarizeUiSettings,
		context,
	});
}

export async function updatePluginUiSettings(
	pluginId: string,
	body: UpdatePluginUiSettingsBody,
	context?: AdminAuditContext,
): Promise<PluginUiSettings> {
	return await changeUiSettings(pluginId, context, async () => await pluginUiSettingsService.update(pluginId, body));
}

export async function resetPluginUiSettings(pluginId: string, context?: AdminAuditContext): Promise<PluginUiSettings> {
	return await changeUiSettings(pluginId, context, async () => {
		await pluginUiSettingsService.reset(pluginId);

		return await pluginUiSettingsService.get(pluginId);
	});
}
