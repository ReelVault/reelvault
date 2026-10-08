import type { PluginUiSettings, UpdatePluginUiSettingsBody } from "@reelvault/sdk/common";
import { pluginUiOverridesRepository } from "@/database/repositories/plugin-ui-overrides.repository";
import { BaseService } from "@/utils/base-service";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { pluginRegistry } from "./plugin.registry";
import { listUiContributions, PLUGIN_UI_MASTER_KEY } from "./plugin-ui-contributions";

/**
 * Administrator switches for what a plugin adds to the web UI. Only deviations
 * from "everything visible" are stored; the registry applies them when it
 * builds the aggregated UI manifest.
 */
class PluginUiSettingsService extends BaseService {
	// Hidden keys per plugin; rebuilt after every write, so it never goes stale and holds one entry per customized plugin.
	private hiddenByPlugin: Map<string, Set<string>> | undefined;

	constructor() {
		super("PluginUiSettingsService");
	}

	async getHiddenByPlugin(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		this.hiddenByPlugin ??= await pluginUiOverridesRepository.listAll();

		return this.hiddenByPlugin;
	}

	async get(pluginId: string): Promise<PluginUiSettings> {
		return await this.safeExecute("get", async () => {
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
		return await this.safeExecute("update", async () => {
			this.assertKnownPlugin(pluginId);
			const manifest = pluginRegistry.getUiManifest(pluginId);
			const known = new Set((manifest ? listUiContributions(manifest) : []).map((item) => item.key));
			for (const key of body.disabledKeys) {
				if (!known.has(key)) {
					throw new ValidationError(`Plugin ${pluginId} has no UI contribution "${key}"`, {
						code: "plugin_ui.unknown_contribution",
						params: { pluginId, key },
					});
				}
			}

			const hidden = new Set(body.disabledKeys);
			if (!body.enabled) hidden.add(PLUGIN_UI_MASTER_KEY);

			await pluginUiOverridesRepository.replaceForPlugin(pluginId, [...hidden]);
			this.hiddenByPlugin = undefined;

			return await this.get(pluginId);
		});
	}

	/** Shows the plugin's whole UI again. Also called when the plugin is uninstalled. */
	async reset(pluginId: string): Promise<void> {
		await pluginUiOverridesRepository.replaceForPlugin(pluginId, []);
		this.hiddenByPlugin = undefined;
	}

	private assertKnownPlugin(pluginId: string): void {
		if (!pluginRegistry.get(pluginId)) {
			throw new NotFoundError(`Plugin not found: ${pluginId}`, { code: "plugin.not_found", params: { pluginId } });
		}
	}
}

export const pluginUiSettingsService = new PluginUiSettingsService();
