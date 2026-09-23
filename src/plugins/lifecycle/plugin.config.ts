import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { KeyedMutex } from "@/utils/mutex";
import { PathUtils } from "@/utils/path.utils";
import { isRecord } from "@/utils/type.utils";

const MAX_CONFIG_BYTES = 512 * 1024;
/** Config holds API keys/tokens — owner-only, never world-readable. */
const CONFIG_FILE_MODE = 0o600;

export class PluginConfig {
	private readonly pluginsDirectory: string;
	/** Serialises read-merge-write per plugin so concurrent saves cannot drop fields. */
	private readonly saveMutex = new KeyedMutex();

	constructor(pluginsDirectory = serverConfig.paths.plugins) {
		this.pluginsDirectory = pluginsDirectory;
	}

	/** Config for the plugin by name. */
	get(pluginName: string): Promise<Record<string, unknown>> {
		try {
			return this.load(this.resolvePluginDirectory(pluginName));
		} catch (e) {
			return Promise.reject(e);
		}
	}

	/** Fully resolved config for a plugin directory, used at runtime. */
	load(pluginDir: string): Promise<Record<string, unknown>> {
		return this.loadRaw(pluginDir);
	}

	async save(pluginName: string, updatedConfig: Record<string, unknown>): Promise<Record<string, unknown>> {
		const pluginDir = this.resolvePluginDirectory(pluginName);

		return await this.saveMutex.runExclusive(pluginName, async () => {
			const existingRaw = await this.loadRaw(pluginDir);
			const mergedConfig: Record<string, unknown> = { ...existingRaw };

			for (const [key, value] of Object.entries(updatedConfig)) {
				mergedConfig[key] = value;
			}

			const serialized = `${JSON.stringify(mergedConfig, null, 2)}\n`;
			if (serialized.length > MAX_CONFIG_BYTES) {
				throw new ValidationError(`Plugin configuration exceeds the ${MAX_CONFIG_BYTES} byte limit`);
			}

			// Atomic write: a crash mid-write must not corrupt the existing config.
			const configPath = PathUtils.join(pluginDir, "config.json");
			await FileUtils.writeAtomic(configPath, serialized, { chmod: CONFIG_FILE_MODE });

			return mergedConfig;
		});
	}

	private async loadRaw(pluginDir: string): Promise<Record<string, unknown>> {
		const configPath = PathUtils.join(pluginDir, "config.json");
		try {
			const config = (await FileUtils.readJson<unknown>(configPath, { silent: true })) ?? {};
			if (!isRecord(config)) return {};

			return config;
		} catch {
			return {};
		}
	}

	resolvePluginDirectory(pluginName: string): string {
		if (!PLUGIN_IDENTIFIER_PATTERN.test(pluginName)) {
			throw new ValidationError("Plugin configuration requested with an invalid directory name");
		}

		return PathUtils.join(this.pluginsDirectory, pluginName);
	}
}
