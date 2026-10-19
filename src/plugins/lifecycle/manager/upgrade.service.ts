import type { InstallCatalogPluginResponse } from "@reelvault/sdk/common";
import { type InstalledPluginRecord, installDirection } from "@/plugins/lifecycle/plugin.installer";
import { pluginErrorCode } from "@/plugins/lifecycle/plugin.status";
import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import { errorMessage } from "@/utils/domain.errors";
import { disabledStatusFromRecord } from "./disabled.service";
import { type PluginManagerState, runLifecycle } from "./state.utils";
import { getStatus } from "./status.reader";

/**
 * Installs (or upgrades) a plugin package from an unpacked directory and brings
 * the plugin to the state it should be in: running, or still disabled if the
 * administrator had switched it off. A new version that does not load is rolled
 * back to the package it replaced.
 */
export async function installFromDirectory(
	state: PluginManagerState,
	sourceDirectory: string,
	options: { source?: string },
): Promise<InstallCatalogPluginResponse> {
	return await runLifecycle(state, async () => {
		const previousRecords = await state.installer.list();
		const result = await state.installer.install(sourceDirectory, {
			upgrade: true,
			...(options.source === undefined ? {} : { source: options.source }),
		});
		state.integrityIssues.delete(result.id);

		const previous = previousRecords.find(({ id }) => id === result.id)?.record;
		const outcome = {
			pluginId: result.id,
			version: result.record.version,
			upgraded: previous !== undefined,
			direction: installDirection(previous?.version, result.record.version),
			...(previous ? { previousVersion: previous.version } : {}),
		};

		// The fresh record carries no disabled flag, so an upgrade would silently re-enable a plugin
		// the administrator switched off — carry the flag over. Such a plugin is not loaded until it is enabled.
		if (previous?.disabled === true) {
			await state.installer.setDisabled(result.id, true);
			state.disabledStatuses.set(result.id, await disabledStatusFromRecord(state, result.id, { ...result.record, disabled: true }));

			return { ...outcome, state: "disabled" };
		}
		state.disabledStatuses.delete(result.id);

		try {
			await activateInstalled(state, result.id, result.record.directory);

			return { ...outcome, state: "enabled" };
		} catch (error) {
			// The recorded failure is what the admin sees, so report that rather than the raw error.
			const failure = getStatus(state).find((status) => status.id === result.id);
			const failed = {
				...outcome,
				error: failure?.error ?? errorMessage(error),
				errorCode: failure?.errorCode ?? pluginErrorCode(error),
			};

			const restored = await rollBackUpgrade(state, result.id);
			if (restored) return { ...failed, version: restored.version, state: "rolled_back" };

			return { ...failed, state: "failed" };
		}
	});
}

/**
 * Loads the installed package. A plugin already in the registry still runs the
 * build it was loaded with, so it is reloaded. Calls the loader directly —
 * the public reload would re-enter the same lock.
 */
export async function activateInstalled(state: PluginManagerState, pluginId: string, directoryName: string): Promise<void> {
	if (state.registry.get(pluginId)) await state.loader.reloadPlugin(pluginId);
	else await state.loader.load(directoryName);

	await confirmUpgrade(state, pluginId);
}

/** The new version runs, so the package it replaced is no longer needed and stale interface switches can go. */
export async function confirmUpgrade(state: PluginManagerState, pluginId: string): Promise<void> {
	if (!(await state.installer.confirmUpgrade(pluginId))) return;

	await pluginUiSettingsService.pruneStale(pluginId);
}

/**
 * Restores the package an unconfirmed upgrade replaced and loads it again.
 * Returns the restored record, or undefined when there is nothing to roll back to.
 */
export async function rollBackUpgrade(state: PluginManagerState, pluginId: string): Promise<InstalledPluginRecord | undefined> {
	let restored: InstalledPluginRecord | undefined;
	try {
		restored = await state.installer.rollbackUpgrade(pluginId);
	} catch (error) {
		state.logger.error(`Plugin ${pluginId} could not be rolled back to its previous version`, error);

		return undefined;
	}
	if (!restored) return undefined;

	// The failed build is no longer what is installed, so its failure must not outlive the rollback.
	state.registry.clearFailure(pluginId);

	if (restored.disabled === true) {
		state.disabledStatuses.set(pluginId, await disabledStatusFromRecord(state, pluginId, restored));

		return restored;
	}

	state.disabledStatuses.delete(pluginId);
	try {
		await state.loader.load(restored.directory);
	} catch (error) {
		state.logger.error(`Plugin ${pluginId} was restored to ${restored.version} but failed to load`, error);
	}

	return restored;
}
