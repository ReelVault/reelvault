import type { PluginConfigDetails, PluginConfigExport } from "@reelvault/sdk/common";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { adminLog } from "@/services/admin/admin.logger";
import { auditedChange } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";

export async function getPluginConfig(pluginId: string): Promise<PluginConfigDetails> {
	return await runSafely(adminLog, "pluginConfig", () => pluginManager.getPluginConfigDetails(pluginId));
}

/** Runs one configuration change and audits its config before and after. */
async function changePluginConfig(
	pluginId: string,
	context: AdminAuditContext | undefined,
	change: (before: PluginConfigDetails) => Promise<PluginConfigDetails>,
): Promise<PluginConfigDetails> {
	const before = await pluginManager.getPluginConfigDetails(pluginId);

	return await auditedChange({
		logger: adminLog.logger,
		resourceType: "plugin_config",
		resourceId: pluginId,
		before: before.config,
		change: async () => await change(before),
		after: (details) => details.config,
		context,
	});
}

export async function updatePluginConfig(
	pluginId: string,
	updatedConfig: Record<string, unknown>,
	context?: AdminAuditContext,
): Promise<PluginConfigDetails> {
	return await runSafely(adminLog, "updatePluginConfig", () =>
		changePluginConfig(pluginId, context, () => pluginManager.savePluginConfig(pluginId, updatedConfig)),
	);
}

export async function resetPluginConfig(
	pluginId: string,
	keys: string[] | undefined,
	context?: AdminAuditContext,
): Promise<PluginConfigDetails> {
	return await runSafely(adminLog, "resetPluginConfig", () =>
		changePluginConfig(pluginId, context, () => pluginManager.resetPluginConfig(pluginId, keys)),
	);
}

/** The configuration an administrator can carry to another installation: every non-secret value. */
export async function exportPluginConfig(pluginId: string): Promise<PluginConfigExport> {
	return await runSafely(adminLog, "exportPluginConfig", async () => {
		const details = await pluginManager.getPluginConfigDetails(pluginId);

		return { format: "reelvault.plugin-config", formatVersion: 1, pluginId: details.id, values: details.config };
	});
}

/**
 * Applies an exported configuration. Secret fields in the file are dropped, so an import can
 * never overwrite a stored credential; everything else goes through the normal config validation.
 */
export async function importPluginConfig(
	pluginId: string,
	body: PluginConfigExport,
	context?: AdminAuditContext,
): Promise<PluginConfigDetails> {
	return await runSafely(adminLog, "importPluginConfig", async () => {
		if (body.pluginId !== pluginId) {
			throw new DomainError("validation", "The configuration file belongs to another plugin", { code: "plugin.config_import_mismatch" });
		}

		return await changePluginConfig(pluginId, context, async (before) => {
			const secretFields = new Set(before.fields.filter((field) => field.type === "secret").map((field) => field.name));
			const values = Object.fromEntries(Object.entries(body.values).filter(([key]) => !secretFields.has(key)));

			return await pluginManager.savePluginConfig(pluginId, values);
		});
	});
}
