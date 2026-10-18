import type { PluginUiSettings, UpdatePluginUiSettingsBody } from "@reelvault/sdk/common";
import { recordUpdateAudit } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import type { AdminServiceState } from "../shared.utils";

/** Compact audit view of a plugin's UI switches: master flag plus the hidden keys. */
function summarizeUiSettings(settings: PluginUiSettings): { enabled: boolean; disabledKeys: string[] } {
	return { enabled: settings.enabled, disabledKeys: settings.contributions.filter((item) => !item.enabled).map((item) => item.key) };
}

function auditUiChange(
	state: AdminServiceState,
	pluginId: string,
	before: PluginUiSettings,
	after: PluginUiSettings,
	context: AdminAuditContext | undefined,
): void {
	recordUpdateAudit(state.logger, {
		resourceType: "plugin_ui_settings",
		resourceId: pluginId,
		before: summarizeUiSettings(before),
		after: summarizeUiSettings(after),
		context,
	});
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
	const after = await pluginUiSettingsService.update(pluginId, body);
	auditUiChange(state, pluginId, before, after, context);

	return after;
}

export async function resetPluginUiSettings(
	state: AdminServiceState,
	pluginId: string,
	context?: AdminAuditContext,
): Promise<PluginUiSettings> {
	const before = await pluginUiSettingsService.get(pluginId);
	await pluginUiSettingsService.reset(pluginId);
	const after = await pluginUiSettingsService.get(pluginId);
	auditUiChange(state, pluginId, before, after, context);

	return after;
}
