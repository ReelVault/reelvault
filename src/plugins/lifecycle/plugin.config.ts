import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { serverConfig } from "@/server.config";
import { KeyedMutex } from "@/utils/concurrency";
import { DomainError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { isRecord } from "@/utils/type.utils";

const CONFIG_FILENAME = "config.json";
const MAX_CONFIG_BYTES = 512 * 1024;
export const PLUGIN_CONFIG_UNREADABLE = "plugin.config_unreadable";
/** Config holds API keys/tokens — owner-only, never world-readable. */
const CONFIG_FILE_MODE = 0o600;

export class PluginConfig {
	private readonly logger = createLogger("PluginConfig");
	private readonly pluginsDirectory: string;
	/** Serialises read-merge-write per plugin so concurrent saves cannot drop fields. */
	private readonly saveMutex = new KeyedMutex();

	constructor(pluginsDirectory = serverConfig.paths.plugins) {
		this.pluginsDirectory = pluginsDirectory;
	}

	/** Fully resolved config for a plugin directory, used at runtime. */
	async load(pluginDir: string): Promise<Record<string, unknown>> {
		const { values, cause } = await this.read(pluginDir);
		if (cause !== undefined) {
			// A config.json that exists but is unreadable would otherwise silently reset the plugin to its defaults.
			this.logger.warn(`Plugin config could not be read — using defaults: ${PathUtils.join(pluginDir, CONFIG_FILENAME)}`, { error: cause });
		}

		return values;
	}

	/** Stable code when `config.json` exists but is unreadable; undefined when it is absent or valid. */
	async readError(pluginDir: string): Promise<string | undefined> {
		return (await this.read(pluginDir)).code;
	}

	private async read(pluginDir: string): Promise<{ values: Record<string, unknown>; code?: string; cause?: unknown }> {
		const configPath = PathUtils.join(pluginDir, CONFIG_FILENAME);
		try {
			if (!(await FileUtils.exists(configPath))) return { values: {} };

			const config = await FileUtils.readJson<unknown>(configPath, { silent: true });
			if (isRecord(config)) return { values: config };

			return { values: {}, code: PLUGIN_CONFIG_UNREADABLE, cause: "not a JSON object" };
		} catch (error) {
			return { values: {}, code: PLUGIN_CONFIG_UNREADABLE, cause: error };
		}
	}

	/** Merges `updatedConfig` into the stored config; keys listed in `remove` are dropped first (a reset to the defaults). */
	async save(
		pluginName: string,
		updatedConfig: Record<string, unknown>,
		pruneTo?: ReadonlySet<string>,
		remove: readonly string[] = [],
	): Promise<Record<string, unknown>> {
		const pluginDir = this.resolvePluginDirectory(pluginName);

		return await this.saveMutex.runExclusive(pluginName, async () => {
			const existingRaw = await this.load(pluginDir);
			const mergedConfig: Record<string, unknown> = { ...existingRaw };
			for (const key of remove) {
				Reflect.deleteProperty(mergedConfig, key);
			}

			for (const [key, value] of Object.entries(updatedConfig)) {
				mergedConfig[key] = value;
			}

			const persistedConfig = pruneTo ? pruneKeys(mergedConfig, pruneTo) : mergedConfig;

			const serialized = `${JSON.stringify(persistedConfig, null, 2)}\n`;
			if (serialized.length > MAX_CONFIG_BYTES) {
				throw new DomainError("validation", `Plugin configuration exceeds the ${MAX_CONFIG_BYTES} byte limit`, {
					code: "plugin.config_too_large",
					params: { maxBytes: MAX_CONFIG_BYTES },
				});
			}

			// Atomic write: a crash mid-write must not corrupt the existing config.
			const configPath = PathUtils.join(pluginDir, CONFIG_FILENAME);
			await FileUtils.writeAtomic(configPath, serialized, { chmod: CONFIG_FILE_MODE });

			return persistedConfig;
		});
	}

	resolvePluginDirectory(pluginName: string): string {
		if (!PLUGIN_IDENTIFIER_PATTERN.test(pluginName)) {
			throw new DomainError("validation", "Plugin configuration requested with an invalid directory name", {
				code: "plugin.config_directory_invalid",
			});
		}

		return PathUtils.join(this.pluginsDirectory, pluginName);
	}
}

function pruneKeys(config: Record<string, unknown>, allowed: ReadonlySet<string>): Record<string, unknown> {
	const pruned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (allowed.has(key)) pruned[key] = value;
	}
	return pruned;
}
