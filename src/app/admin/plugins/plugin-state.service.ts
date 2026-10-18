import type { PluginAdminStatus, PluginBulkStateBody, PluginBulkStateResult } from "@reelvault/sdk/common";
import { recordUpdateAudit } from "@/app/admin/admin-audit.service";
import { pluginAdminService } from "@/app/plugins/plugin-admin.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { type AdminServiceState, requirePlugin } from "../shared.utils";

type PluginAction = "enable" | "disable" | "reload";

const PLUGIN_ACTIONS: Record<PluginAction, (pluginId: string) => Promise<PluginAdminStatus | undefined>> = {
	enable: (pluginId) => pluginAdminService.enable(pluginId),
	disable: (pluginId) => pluginAdminService.disable(pluginId),
	reload: (pluginId) => pluginAdminService.reload(pluginId),
};

export async function getPluginStatus(pluginId: string): Promise<PluginAdminStatus> {
	return requirePlugin(await pluginAdminService.get(pluginId), pluginId);
}

/** Enables or disables several plugins. Each one is attempted on its own, so one failure does not stop the rest. */
export async function setPluginsEnabled(
	state: AdminServiceState,
	body: PluginBulkStateBody,
	context?: AdminAuditContext,
): Promise<PluginBulkStateResult> {
	return await runSafely(state, "setPluginsEnabled", async () => {
		const results: PluginBulkStateResult["results"] = [];
		for (const pluginId of body.pluginIds) {
			try {
				await pluginManager.setEnabled(pluginId, body.enabled);
				results.push({ pluginId, ok: true });
			} catch (error) {
				results.push({
					pluginId,
					ok: false,
					error: errorMessage(error),
					...(error instanceof DomainError ? { errorCode: error.code } : {}),
				});
			}
		}

		recordUpdateAudit(state.logger, {
			resourceType: "plugins",
			after: {
				action: body.enabled ? "bulk_enable" : "bulk_disable",
				pluginIds: body.pluginIds,
				failed: results.filter((result) => !result.ok).map((result) => result.pluginId),
			},
			context,
		});

		return { results };
	});
}

/**
 * Admin choice on the installed package (`pinned`, `cspDisabled`): `apply` writes the flag, and the audit
 * entry records its value before and after.
 */
async function setPackageFlag(
	state: AdminServiceState,
	change: { pluginId: string; flag: "pinned" | "cspDisabled"; value: boolean; apply: () => Promise<void> },
	context?: AdminAuditContext,
): Promise<PluginAdminStatus> {
	const { pluginId, flag, value, apply } = change;
	const before = await pluginManager.getPackageDetails(pluginId);
	await apply();
	recordUpdateAudit(state.logger, {
		resourceType: "plugin",
		resourceId: pluginId,
		before: { [flag]: before[flag] === true },
		after: { [flag]: value },
		context,
	});

	return await getPluginStatus(pluginId);
}

/** Admin choice: keep the installed version (`pinned: true`) or allow catalog updates again. */
export async function setPluginPinned(
	state: AdminServiceState,
	pluginId: string,
	pinned: boolean,
	context?: AdminAuditContext,
): Promise<PluginAdminStatus> {
	return await runSafely(state, "setPluginPinned", () =>
		setPackageFlag(
			state,
			{ pluginId, flag: "pinned", value: pinned, apply: () => pluginManager.setPluginPinned(pluginId, pinned) },
			context,
		),
	);
}

/** Admin choice: allow (`enabled: true`) or refuse the CSP sources the plugin's manifest declares. */
export async function setPluginCspEnabled(
	state: AdminServiceState,
	pluginId: string,
	enabled: boolean,
	context?: AdminAuditContext,
): Promise<PluginAdminStatus> {
	return await runSafely(state, "setPluginCspEnabled", () =>
		setPackageFlag(
			state,
			{ pluginId, flag: "cspDisabled", value: !enabled, apply: () => pluginManager.setPluginCspDisabled(pluginId, !enabled) },
			context,
		),
	);
}

export async function changePluginStatus(
	state: AdminServiceState,
	action: PluginAction,
	pluginId: string,
	context?: AdminAuditContext,
): Promise<PluginAdminStatus> {
	const plugin = requirePlugin(await PLUGIN_ACTIONS[action](pluginId), pluginId);

	recordUpdateAudit(state.logger, {
		resourceType: "plugin",
		resourceId: pluginId,
		after: { status: action === "reload" ? "reloaded" : action, plugin },
		context,
	});

	return plugin;
}

export async function reloadAllPlugins(state: AdminServiceState, context?: AdminAuditContext): Promise<PluginAdminStatus[]> {
	await pluginManager.reloadAll();
	const result = await pluginAdminService.list();
	recordUpdateAudit(state.logger, {
		resourceType: "plugins",
		after: { action: "reload_all", total: result.length },
		context,
	});

	return result;
}
