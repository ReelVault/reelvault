import type { PluginConfigDetails } from "@reelvault/sdk/common";
import type { PluginConfigField } from "@reelvault/sdk/plugin";
import { loadPluginManifest } from "@/plugins/lifecycle/plugin.manifest";
import type { PluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { inferFieldsFromConfig, isBlankConfigValue, markSecretPresence, redactSecretValues, withoutKeys } from "./config-fields.utils";
import { reloadPlugin } from "./lifecycle.service";
import { directoryNameOf, type PluginManagerState, pluginDirectoryOf } from "./state.utils";

type ConfigDefinition = NonNullable<ReturnType<PluginRegistry["getConfigDefinition"]>>;

/** SDK config errors read `Plugin configuration '<field>' …`; surface the field. */
const PLUGIN_CONFIG_FIELD_REGEX = /Plugin configuration '([^']+)'/;

function pluginConfigField(error: unknown): string | undefined {
	return PLUGIN_CONFIG_FIELD_REGEX.exec(errorMessage(error))?.[1];
}

function invalidConfigError(message: string, field: string | undefined): DomainError {
	return new DomainError("validation", message, {
		code: "plugin.config_invalid",
		...(field ? { params: { field } } : {}),
	});
}

export async function getPluginConfigDetails(state: PluginManagerState, pluginId: string): Promise<PluginConfigDetails> {
	const pluginDir = await pluginDirectoryOf(state, pluginId);
	const manifest = await loadPluginManifest(pluginDir);
	const config = await state.config.load(pluginDir);
	// The config schema travels with the loaded plugin module (`defineConfig`);
	// a failed load keeps its definition too, so the plugin stays configurable.
	const definition = state.registry.getConfigDefinition(pluginId);

	const fields: PluginConfigField[] =
		definition?.descriptors && definition.descriptors.length > 0 ? [...definition.descriptors] : inferFieldsFromConfig(config);

	return {
		id: manifest.id,
		name: manifest.name,
		version: manifest.version,
		...(manifest.description ? { description: manifest.description } : {}),
		config: redactSecretValues(config, fields),
		fields: markSecretPresence(fields, config),
	};
}

/** The config as stored on disk, secrets included. */
export async function loadStoredConfig(state: PluginManagerState, pluginId: string): Promise<Record<string, unknown>> {
	return await state.config.load(await pluginDirectoryOf(state, pluginId));
}

/**
 * Validates the merged result (not the patch) and persists it, then reloads the plugin. A redacted secret omitted
 * by the admin form keeps its stored value, and required fields are checked against what will actually be saved.
 */
export async function writePluginConfig(
	state: PluginManagerState,
	pluginId: string,
	updatedConfig: Record<string, unknown>,
	remove: readonly string[],
): Promise<void> {
	const dirName = await directoryNameOf(state, pluginId);
	const definition = state.registry.getConfigDefinition(pluginId);
	let pruneTo: ReadonlySet<string> | undefined;
	if (definition) {
		// Drop keys outside the declared schema so arbitrary junk from a stale
		// client can never reach config.json (or the plugin's parsed config).
		// The stored config is pruned with the same rule, cleaning up junk
		// persisted before this guard existed.
		pruneTo = new Set(definition.descriptors.map((descriptor) => descriptor.name));

		const existing = await state.config.load(state.config.resolvePluginDirectory(dirName));
		assertSavableConfig(definition, { ...withoutKeys(existing, remove), ...updatedConfig });
	}

	await state.config.save(dirName, updatedConfig, pruneTo, remove);
	try {
		await reloadPlugin(state, pluginId);
	} catch (error) {
		// The config is saved either way; surface why the plugin did not pick it up.
		state.logger.warn(`Plugin ${pluginId} saved its configuration but failed to reload`, { error });
	}
}

/**
 * Parses and checks a config against its definition. `required` is a UI/save-time contract: loading must still
 * work for a plugin whose key has not been entered yet, but an admin cannot save a form that leaves it blank.
 */
function assertSavableConfig(definition: ConfigDefinition, merged: Record<string, unknown>): void {
	const parsed = parseConfig(definition, merged);
	const blank = definition.descriptors.find((descriptor) => descriptor.required === true && isBlankConfigValue(parsed[descriptor.name]));
	if (blank) throw invalidConfigError(`Plugin configuration '${blank.name}' is required`, blank.name);
}

function parseConfig(definition: ConfigDefinition, merged: Record<string, unknown>): Record<string, unknown> {
	try {
		return definition.parse(merged);
	} catch (error) {
		throw invalidConfigError(errorMessage(error), pluginConfigField(error));
	}
}
