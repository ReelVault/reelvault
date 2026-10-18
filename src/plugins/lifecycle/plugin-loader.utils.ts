import type { ConfigDefinition, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import type { PluginScope } from "./host/plugin.scope";
import type { loadPluginManifest } from "./plugin.manifest";

export type LoadedPluginManifest = Awaited<ReturnType<typeof loadPluginManifest>>;

/** Runtime record for a plugin whose setup() has finished, before it is registered. */
export function buildPluginRuntime(
	manifest: LoadedPluginManifest,
	plugin: ReelVaultPlugin,
	configDefinition: ConfigDefinition | undefined,
	scope: PluginScope,
): PluginRuntime {
	return {
		manifest,
		plugin,
		...(configDefinition ? { configDefinition } : {}),
		state: "initialized",
		providerIds: scope.getProviderIds(),
		subtitleProviderIds: scope.getSubtitleProviderIds(),
		analyzerIds: scope.getAnalyzerIds(),
		jobNames: scope.getJobNames(),
	};
}

export function isReelVaultPlugin(value: unknown): value is ReelVaultPlugin {
	return typeof value === "object" && value !== null && "setup" in value && typeof value.setup === "function";
}

/** Preserves Error identity and wraps exotic throws so lifecycle failures stay throwable. */
export function toLifecycleError(error: unknown): Error {
	if (error instanceof Error) return error;

	return new Error("Plugin lifecycle hook failed", { cause: error });
}
