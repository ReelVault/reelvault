import { pluginUiSettingsService } from "@/plugins/lifecycle/plugin-ui-settings.service";
import { DomainError } from "@/utils/domain.errors";
import { statusFromManifest, statusFromRegistry } from "./disabled.service";
import { directoryNameOf, type PluginManagerState, runLifecycle } from "./state.utils";
import { confirmUpgrade, rollBackUpgrade } from "./upgrade.service";

/**
 * Persists the enabled/disabled state and (un)loads under one lock, so two
 * concurrent enable/disable requests cannot interleave with each other or
 * with an install/reload.
 */
export async function setPluginEnabled(state: PluginManagerState, pluginId: string, enabled: boolean): Promise<void> {
	await runLifecycle(state, async () => {
		try {
			await state.installer.setDisabled(pluginId, !enabled);
		} catch (error) {
			// Non-installer plugins have no lockfile entry — unload/load only; any
			// other failure (unreadable lockfile, I/O) must surface.
			if (!(error instanceof DomainError && error.code === "plugin.not_installed")) throw error;
		}

		if (enabled) await enablePlugin(state, pluginId);
		else await disablePlugin(state, pluginId);
	});
}

async function enablePlugin(state: PluginManagerState, pluginId: string): Promise<void> {
	try {
		await state.loader.load(await directoryNameOf(state, pluginId));
	} catch (error) {
		// A failed load leaves the plugin in the failed registry bucket — it must not linger as disabled.
		state.disabledStatuses.delete(pluginId);
		// An upgrade that does not load goes back to the package it replaced.
		const restored = await rollBackUpgrade(state, pluginId);
		if (!restored) throw error;

		throw new DomainError("validation", `Plugin ${pluginId} did not load; version ${restored.version} was restored`, {
			cause: error,
			code: "plugin.upgrade_rolled_back",
			params: { pluginId, version: restored.version },
		});
	}

	state.disabledStatuses.delete(pluginId);
	await confirmUpgrade(state, pluginId);
}

async function disablePlugin(state: PluginManagerState, pluginId: string): Promise<void> {
	// Unloading removes the plugin from the registry, so its status must be captured first —
	// this map is then the only place that still knows the plugin exists.
	const status =
		statusFromRegistry(state, pluginId) ??
		state.disabledStatuses.get(pluginId) ??
		(await statusFromManifest(state, pluginId, await directoryNameOf(state, pluginId)));
	if (!status) {
		throw new DomainError("validation", `Plugin ${pluginId} is not installed`, {
			code: "plugin.not_installed",
			params: { plugin: pluginId },
		});
	}

	try {
		// unloadPlugin unregisters even when lifecycle hooks fail (it throws afterwards),
		// so the disabled status must be recorded either way.
		await state.loader.unloadPlugin(pluginId);
	} finally {
		state.disabledStatuses.set(pluginId, status);
	}
}

/** Full reload: unload every plugin first, then load them again. */
export async function reloadAllPlugins(state: PluginManagerState): Promise<void> {
	await runLifecycle(state, async () => {
		// awaits: sequential — plugins unload before they reload
		await state.loader.unloadAll();
		await state.loader.loadAll();
	});
}

export async function loadPlugin(state: PluginManagerState, pluginName: string): Promise<void> {
	await runLifecycle(state, () => state.loader.load(pluginName));
}

export async function reloadPlugin(state: PluginManagerState, pluginId: string): Promise<void> {
	await runLifecycle(state, async () => {
		// load() ignores the lockfile flag — reloading a disabled plugin would silently enable it until restart.
		if (state.disabledStatuses.has(pluginId)) return;

		await state.loader.reloadPlugin(pluginId);
	});
}

export async function unloadPlugin(state: PluginManagerState, pluginId: string): Promise<void> {
	await runLifecycle(state, () => state.loader.unloadPlugin(pluginId));
}

export async function uninstallPlugin(state: PluginManagerState, pluginId: string): Promise<void> {
	await runLifecycle(state, async () => {
		await state.loader.prepareUninstall(pluginId);
		try {
			// Package first: if removing the directory/lockfile fails, the plugin
			// is still installed and its data must survive. The reverse order
			// wiped user data and then left a package that looked installed.
			// Manually dropped plugins have no lockfile record — their data is
			// removed below regardless.
			await state.installer.uninstall(pluginId);
		} catch (error) {
			if (!(error instanceof DomainError && error.category === "validation")) throw error;

			state.logger.warn(`No installer record for ${pluginId} — removed loaded data only`);
		}

		// awaits: sequential — the UI settings are reset only after the plugin data is removed
		await state.loader.removePluginData(pluginId);
		await pluginUiSettingsService.reset(pluginId);

		// Cleared only after the installer succeeded — a failed uninstall leaves the plugin installed.
		state.disabledStatuses.delete(pluginId);
		state.registry.setCspDisabled(pluginId, false);
	});
}
