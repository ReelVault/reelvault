import type { PluginUiSettings, UpdatePluginUiSettingsBody } from "@reelvault/sdk/common";
import { pluginUiOverrideData } from "@/services/plugins/plugin-data.service";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { pluginRegistry } from "./plugin.registry";
import { listUiContributions, PLUGIN_UI_MASTER_KEY } from "./plugin-ui-contributions.utils";

/**
 * Administrator switches for what a plugin adds to the web UI. Only deviations
 * from "everything visible" are stored; the registry applies them when it
 * builds the aggregated UI manifest.
 */
class PluginUiSettingsService {
	readonly serviceName = "PluginUiSettingsService";
	readonly logger = createLogger("PluginUiSettingsService");

	// Hidden keys per plugin; rebuilt after every write, so it never goes stale and holds one entry per customized plugin.
	private hiddenByPlugin: Map<string, Set<string>> | undefined;

	async getHiddenByPlugin(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		this.hiddenByPlugin ??= await pluginUiOverrideData.listAll();

		return this.hiddenByPlugin;
	}

	async get(pluginId: string): Promise<PluginUiSettings> {
		return await runSafely(this, "get", async () => {
			this.assertKnownPlugin(pluginId);
			const hidden = (await this.getHiddenByPlugin()).get(pluginId);
			const manifest = pluginRegistry.getUiManifest(pluginId);
			const contributions = (manifest ? listUiContributions(manifest) : []).map((item) => ({
				...item,
				enabled: !hidden?.has(item.key),
			}));

			return { pluginId, enabled: !hidden?.has(PLUGIN_UI_MASTER_KEY), contributions };
		});
	}

	async update(pluginId: string, body: UpdatePluginUiSettingsBody): Promise<PluginUiSettings> {
		return await runSafely(this, "update", async () => {
			this.assertKnownPlugin(pluginId);
			const manifest = pluginRegistry.getUiManifest(pluginId);
			const known = new Set((manifest ? listUiContributions(manifest) : []).map((item) => item.key));
			for (const key of body.disabledKeys) {
				if (!known.has(key)) {
					throw new DomainError("validation", `Plugin ${pluginId} has no UI contribution "${key}"`, {
						code: "plugin_ui.unknown_contribution",
						params: { pluginId, key },
					});
				}
			}

			const hidden = new Set(body.disabledKeys);
			if (!body.enabled) hidden.add(PLUGIN_UI_MASTER_KEY);

			await pluginUiOverrideData.replaceForPlugin(pluginId, [...hidden]);
			this.hiddenByPlugin = undefined;

			return await this.get(pluginId);
		});
	}

	/**
	 * Drops switches that point at contributions the plugin no longer declares, once an upgrade runs.
	 * Skipped without an interface manifest: that may be a broken ui.json, and its switches are worth keeping.
	 */
	async pruneStale(pluginId: string): Promise<void> {
		const manifest = pluginRegistry.getUiManifest(pluginId);
		const hidden = (await this.getHiddenByPlugin()).get(pluginId);
		if (!(manifest && hidden)) return;

		const known = new Set(listUiContributions(manifest).map((item) => item.key));
		const kept = [...hidden].filter((key) => key === PLUGIN_UI_MASTER_KEY || known.has(key));
		if (kept.length === hidden.size) return;

		await pluginUiOverrideData.replaceForPlugin(pluginId, kept);
		this.hiddenByPlugin = undefined;
	}

	/** Shows the plugin's whole UI again. Also called when the plugin is uninstalled. */
	async reset(pluginId: string): Promise<void> {
		await pluginUiOverrideData.replaceForPlugin(pluginId, []);
		this.hiddenByPlugin = undefined;
	}

	private assertKnownPlugin(pluginId: string): void {
		if (!pluginRegistry.get(pluginId)) {
			throw new DomainError("not_found", `Plugin not found: ${pluginId}`, { code: "plugin.not_found", params: { pluginId } });
		}
	}
}

export const pluginUiSettingsService = new PluginUiSettingsService();
