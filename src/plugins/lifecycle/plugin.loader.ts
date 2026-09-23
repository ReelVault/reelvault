import { pathToFileURL } from "node:url";
import type { ConfigDefinition, PluginLoadPhase, PluginRuntime, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { isConfigDefinition } from "@reelvault/sdk/plugin";
import { realtimeService } from "@/modules/realtime";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { serverConfig } from "@/server.config";
import { hasEntry } from "@/utils/array.utils";
import { DirUtils } from "@/utils/directory.utils";
import { errorMessage, ValidationError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";
import { workerService } from "@/workers/worker.service";
import { pluginArtifactsService } from "../capabilities/plugin.artifacts";
import { pluginBlobsService } from "../capabilities/plugin.blobs";
import { pluginStorageService } from "../capabilities/plugin.storage";
import { pluginAccessBus } from "../runtime/plugin.access";
import { pluginEventBus } from "../runtime/plugin.events";
import { PluginScope } from "./host/plugin.scope";
import { isPluginDirectoryName, PluginDirectoryIndex } from "./host/plugin-directory.index";
import { createPluginHost } from "./host/plugin-host.factory";
import type { PluginConfig } from "./plugin.config";
import { PluginInstaller } from "./plugin.installer";
import {
	loadPluginManifest,
	resolvePluginEntry,
	resolvePluginUiSchemas,
	validatePluginConfig,
	validatePluginUiManifest,
} from "./plugin.manifest";
import type { PluginRegistry } from "./plugin.registry";
import { clearPluginRuntimes, materializePluginRuntime, pluginRuntimeRoot } from "./plugin-runtime-copy";
import { ensurePluginSdkShim } from "./plugin-sdk-alias";

export class PluginLoader {
	private readonly logger = createLogger("PluginLoader");
	private readonly config: PluginConfig;
	private readonly registry: PluginRegistry;
	private readonly pluginsDirectory: string;
	private readonly runtimeRoot: string;
	private readonly directoryIndex = new PluginDirectoryIndex();
	private readonly pluginScopes = new Map<string, PluginScope>();

	constructor(config: PluginConfig, registry: PluginRegistry, pluginsDirectory = serverConfig.paths.plugins) {
		this.config = config;
		this.registry = registry;
		this.pluginsDirectory = pluginsDirectory;
		this.runtimeRoot = pluginRuntimeRoot(pluginsDirectory);
	}

	/** Materialised module-graph directory of a currently loaded plugin, if any. */
	getRuntimeDirectory(pluginId: string): string | undefined {
		return this.pluginScopes.get(pluginId)?.getRuntimeDirectory();
	}

	/** Resolves a plugin id to its directory name via the id→directory index, refreshing it when the entry is missing or stale. */
	async findDirectoryNameForPluginId(pluginId: string): Promise<string | undefined> {
		return await this.directoryIndex.resolve(pluginId, this.pluginsDirectory);
	}

	async loadAll(): Promise<void> {
		// Must precede the first entry import: plugin code imports the SDK by package name.
		await ensurePluginSdkShim(this.pluginsDirectory);
		// Boot / reload-all: stale mirrors from a crash are safe to drop before materialising fresh ones.
		await clearPluginRuntimes(this.runtimeRoot);
		await pluginBlobsService.purgeExpired();
		await this.directoryIndex.refresh(this.pluginsDirectory);
		const pluginNames = (await DirUtils.listDirs(this.pluginsDirectory)).filter((name) => isPluginDirectoryName(name));
		if (pluginNames.length === 0) {
			this.logger.info("No plugins found");

			return;
		}

		// Disabled plugins persist that state in the lockfile (keyed by id); resolve ids
		// to directory names through the index (identity is the installer fallback).
		const disabledIds = await new PluginInstaller(this.pluginsDirectory).getDisabledIds();
		const disabledDirectoryNames = new Set<string>();
		for (const id of disabledIds) {
			disabledDirectoryNames.add(this.directoryIndex.get(id) ?? id);
		}

		const loadableNames = pluginNames.filter((name) => !disabledDirectoryNames.has(name));
		const skippedCount = pluginNames.length - loadableNames.length;
		if (skippedCount > 0) {
			this.logger.info(`Skipped ${skippedCount} disabled plugin(s)`);
		}

		if (loadableNames.length === 0) {
			this.logger.info("No loadable plugins found");

			return;
		}

		this.logger.info(`Found ${loadableNames.length} plugins to load`);

		const results = await PromiseUtils.mapConcurrent(
			loadableNames,
			serverConfig.plugins.lifecycle.loadConcurrency,
			async (name): Promise<PromiseSettledResult<void>> => {
				try {
					await PromiseUtils.withTimeout(this.load(name), serverConfig.plugins.lifecycle.loadTimeoutMs);

					return { status: "fulfilled", value: undefined };
				} catch (reason) {
					return { status: "rejected", reason };
				}
			},
		);

		let successful = 0;
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (!result) continue;

			if (result.status === "fulfilled") {
				successful++;
			} else {
				this.logger.error("Plugin failed to load", result.reason, { pluginName: loadableNames[i] });
			}
		}

		const failed = results.length - successful;
		this.logger.info(`Loaded: ${successful}/${loadableNames.length} plugins (errors: ${failed})`);
	}

	async load(pluginNameOrId: string): Promise<void> {
		// Keep the SDK shim current on every load — catalog-installed plugins ship without node_modules.
		await ensurePluginSdkShim(this.pluginsDirectory);

		// Never join an unvalidated identifier: a `..%2F` path param must not escape the plugins directory.
		if (!PLUGIN_IDENTIFIER_PATTERN.test(pluginNameOrId)) {
			throw new ValidationError("Invalid plugin identifier", { code: "plugin.invalid_identifier" });
		}

		let pluginDir = PathUtils.join(this.pluginsDirectory, pluginNameOrId);
		let pluginName = pluginNameOrId;
		let isDir = await DirUtils.exists(pluginDir);

		if (!isDir) {
			// Not a directory name — resolve by manifest id through the index instead of rescanning.
			const resolvedName = await this.findDirectoryNameForPluginId(pluginNameOrId);
			if (resolvedName) {
				pluginName = resolvedName;
				pluginDir = PathUtils.join(this.pluginsDirectory, resolvedName);
				isDir = true;
			}
		}

		// Defense in depth — the resolved directory must stay inside the plugins root.
		if (!PathUtils.isSubpath(pluginDir, this.pluginsDirectory)) {
			throw new ValidationError("Invalid plugin directory", { code: "plugin.invalid_identifier" });
		}

		const scope = new PluginScope();
		let trackedPluginId: string | undefined;
		let manifest: Awaited<ReturnType<typeof loadPluginManifest>> | undefined;
		let plugin: ReelVaultPlugin | undefined;
		let configDefinition: ConfigDefinition | undefined;
		let failurePhase: PluginLoadPhase | undefined;

		try {
			manifest = await loadPluginManifest(pluginDir);
			this.directoryIndex.set(manifest.id, pluginName);

			const existing = this.registry.get(manifest.id);
			if (existing) {
				if (existing.state !== "failed") {
					this.logger.warn(`Plugin ${manifest.id} already loaded, skipping`);

					return;
				}

				this.registry.unregister(manifest.id);
			}

			this.registry.begin(manifest);
			trackedPluginId = manifest.id;
			// Import from a unique hard-linked mirror so an in-place upgrade can never
			// be served from Bun's path-keyed ESM cache.
			const runtimeDirectory = await materializePluginRuntime(pluginDir, this.runtimeRoot);
			scope.setRuntimeDirectory(runtimeDirectory);
			this.registry.markPhase(manifest.id, "config");
			const rawConfig = await this.config.load(pluginDir);
			this.registry.advance(manifest.id, "validated", "config");

			// Load optional ui.json
			const uiManifestPath = PathUtils.join(pluginDir, "ui.json");
			const uiManifestRaw = await FileUtils.readJson<unknown>(uiManifestPath, { silent: true });
			if (uiManifestRaw !== null) {
				try {
					validatePluginUiManifest(uiManifestRaw);
					// Inline schemaRef files so the client receives renderable schemas.
					scope.setUiManifest(await resolvePluginUiSchemas(pluginDir, uiManifestRaw));
				} catch (error) {
					// ui.json is optional — a malformed manifest skips UI contributions, not the plugin.
					this.logger.warn("Skipping invalid plugin ui.json", { pluginDir, error: errorMessage(error) });
				}
			}

			this.registry.markPhase(manifest.id, "entry");
			const entryPath = resolvePluginEntry(runtimeDirectory, manifest);
			this.registry.advance(manifest.id, "resolved", "entry");
			this.registry.markPhase(manifest.id, "import");
			const module: unknown = await import(pathToFileURL(entryPath).href);
			const defaultExport = isRecord(module) ? module.default : undefined;
			if (!defaultExport) {
				throw new ValidationError(`Plugin ${manifest.id} is missing a default export`);
			}

			if (!isReelVaultPlugin(defaultExport)) throw new ValidationError(`Plugin ${manifest.id} has an invalid default export`);

			plugin = defaultExport;

			// Parse the stored values through the plugin's own config schema before setup() sees them.
			configDefinition = isRecord(defaultExport) && isConfigDefinition(defaultExport.config) ? defaultExport.config : undefined;
			const config = validatePluginConfig(rawConfig, configDefinition);
			this.registry.markPhase(manifest.id, "setup");

			const pluginLogger = createLogger(`Plugin:${manifest.id}`);
			scope.setDeclaredCapabilities(manifest.capabilities);

			await plugin.setup(createPluginHost(manifest.id, pluginLogger, config, scope));
			scope.assertDeclaredCapabilities(manifest.capabilities);
			this.registry.advance(manifest.id, "initialized", "initialization");

			await scope.initializeProviders(config);
			await scope.registerJobs(manifest.id);
			scope.registerHttpRoutes(manifest.id);
			this.registry.markPhase(manifest.id, "activation");

			const runtime: PluginRuntime = {
				manifest,
				plugin,
				...(configDefinition ? { configDefinition } : {}),
				state: "initialized",
				providerIds: scope.getProviderIds(),
				subtitleProviderIds: scope.getSubtitleProviderIds(),
				analyzerIds: scope.getAnalyzerIds(),
				jobNames: scope.getJobNames(),
			};
			this.registry.register(runtime, scope.getProviders(), scope.getAnalyzers(), scope.getSubtitleProviders());
			this.pluginScopes.set(manifest.id, scope);

			const uiManifest = scope.getUiManifest();
			if (uiManifest) {
				this.registry.setUiManifest(manifest.id, uiManifest);
			}

			if (plugin.onEnable) {
				await plugin.onEnable();
			}

			this.registry.enable(manifest.id);
			await pluginEventBus.emit("plugin.enabled", { pluginId: manifest.id });
			realtimeService.broadcast("plugin:enabled", { pluginId: manifest.id });

			this.logger.info(`Plugin [${manifest.id}@${manifest.version}] loaded successfully`, {
				hasConfig: hasEntry(config),
				providers: runtime.providerIds.length,
				subtitleProviders: runtime.subtitleProviderIds.length,
				jobs: runtime.jobNames.length,
			});
		} catch (err) {
			await scope.cleanup();
			// A partially-initialized plugin may have opened timers/sockets during setup().
			if (plugin?.onUnload) {
				try {
					await plugin.onUnload();
				} catch (unloadError) {
					this.logger.warn("Plugin onUnload failed during load error cleanup", {
						pluginId: trackedPluginId,
						error: errorMessage(unloadError),
					});
				}
			}

			if (trackedPluginId) {
				this.registry.fail(trackedPluginId, err, configDefinition);
				failurePhase = this.registry.get(trackedPluginId)?.failurePhase;
				this.registry.unregister(trackedPluginId, true);
				this.directoryIndex.delete(trackedPluginId);
				this.pluginScopes.delete(trackedPluginId);
			} else if (manifest) {
				this.registry.recordFailure(manifest, err, failurePhase, configDefinition);
			}

			this.logger.error(`Failed to load plugin ${pluginName}`, err, { failurePhase });
			throw err;
		}
	}

	async reloadPlugin(pluginId: string): Promise<void> {
		const pluginName = (await this.findDirectoryNameForPluginId(pluginId)) ?? pluginId;

		await this.unloadPlugin(pluginId);
		await this.load(pluginName);
	}

	async unloadPlugin(pluginId: string): Promise<void> {
		const runtime = this.registry.get(pluginId);
		if (!runtime) {
			this.registry.unregister(pluginId);
			this.directoryIndex.delete(pluginId);
			this.pluginScopes.delete(pluginId);

			return;
		}

		if (runtime.state === "failed" || !runtime.plugin) {
			try {
				await this.pluginScopes.get(pluginId)?.cleanup();
			} catch {
				// A failed plugin's cleanup errors were already recorded in the registry.
			}

			this.registry.unregister(pluginId);
			this.directoryIndex.delete(pluginId);
			this.pluginScopes.delete(pluginId);

			return;
		}

		this.registry.disable(pluginId);
		pluginAccessBus.offPlugin(pluginId);
		await pluginEventBus.emit("plugin.disabled", { pluginId });
		realtimeService.broadcast("plugin:disabled", { pluginId });
		let lifecycleError: Error | undefined;

		try {
			await runtime.plugin.onDisable?.();
		} catch (error) {
			lifecycleError = toLifecycleError(error);
		}

		try {
			await this.pluginScopes.get(pluginId)?.cleanup();
		} catch (error) {
			lifecycleError ??= toLifecycleError(error);
		}

		try {
			await runtime.plugin.onUnload?.();
		} catch (error) {
			lifecycleError ??= toLifecycleError(error);
		} finally {
			this.registry.unregister(pluginId);
			this.directoryIndex.delete(pluginId);
			this.pluginScopes.delete(pluginId);
		}

		this.logger.info(`Plugin ${pluginId} unloaded`);
		if (lifecycleError) throw lifecycleError;
	}

	/**
	 * Unloads every registered plugin on process shutdown so `onDisable`,
	 * `onUnload` and provider `dispose()` get to run. Each unload is time-boxed
	 * and its failure only logged — a misbehaving plugin must not be able to
	 * stall or abort the server exit.
	 */
	async unloadAll(): Promise<void> {
		const pluginIds = this.registry.getAll().map((runtime) => runtime.manifest.id);
		if (pluginIds.length === 0) return;

		await PromiseUtils.mapConcurrent(pluginIds, serverConfig.plugins.lifecycle.disposeConcurrency, async (pluginId) => {
			try {
				await PromiseUtils.withTimeout(
					this.unloadPlugin(pluginId),
					serverConfig.plugins.lifecycle.unloadTimeoutMs,
					`Unload of ${pluginId}`,
				);
			} catch (error) {
				this.logger.error("Plugin failed to unload cleanly during shutdown", error, { pluginId });
			}
		});
	}

	async uninstallPlugin(pluginId: string): Promise<void> {
		// Capture job ids before unloading so in-flight handlers can be drained first.
		const jobNames = this.pluginScopes.get(pluginId)?.getJobNames() ?? [];
		await this.unloadPlugin(pluginId);
		try {
			await workerService.drainWorkers(jobNames, serverConfig.plugins.lifecycle.unloadTimeoutMs);
		} catch (error) {
			// Bounded drain: proceed with removal even if a handler ignored its abort.
			this.logger.warn("Plugin job drain failed before data removal", { pluginId, error: errorMessage(error) });
		}

		this.directoryIndex.delete(pluginId);
		await Promise.all([
			pluginStorageService.removeForPlugin(pluginId),
			pluginBlobsService.removeForPlugin(pluginId),
			pluginArtifactsService.removeForPlugin(pluginId),
		]);
		this.logger.info(`Plugin ${pluginId} data removed`);
	}
}

function isReelVaultPlugin(value: unknown): value is ReelVaultPlugin {
	return typeof value === "object" && value !== null && "setup" in value && typeof value.setup === "function";
}

/** Preserves Error identity and wraps exotic throws so lifecycle failures stay throwable. */
function toLifecycleError(error: unknown): Error {
	if (error instanceof Error) return error;

	return new Error("Plugin lifecycle hook failed", { cause: error });
}
