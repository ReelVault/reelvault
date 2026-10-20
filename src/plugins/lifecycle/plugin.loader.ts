import { pathToFileURL } from "node:url";
import type { ConfigDefinition, PluginLoadPhase, ReelVaultPlugin } from "@reelvault/sdk/plugin";
import { isConfigDefinition } from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { pluginArtifactsService } from "@/plugins/capabilities/plugin.artifacts";
import { pluginBlobsService } from "@/plugins/capabilities/plugin.blobs";
import { pluginStorageService } from "@/plugins/capabilities/plugin.storage";
import { resolvePluginDirectoryName } from "@/plugins/lifecycle/host/plugin-directory.resolver";
import { PluginLockfileStore } from "@/plugins/lifecycle/installer/lockfile.store";
import { pluginAccessBus } from "@/plugins/runtime/plugin.access";
import { PLUGIN_IDENTIFIER_PATTERN } from "@/plugins/shared/plugin.constants";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { hasEntry } from "@/utils/array.utils";
import { directoryExists } from "@/utils/directory.utils";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { readJsonFile } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { isSubpath, joinPath } from "@/utils/path.utils";
import { mapConcurrent, withTimeout } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";
import { workerService } from "@/workers/worker.service";
import { PluginScope } from "./host/plugin.scope";
import { PluginDirectoryIndex } from "./host/plugin-directory.indexer";
import { createPluginHost } from "./host/plugin-host.factory";
import { validatePluginUiManifest } from "./manifest/ui.validator";
import type { PluginConfig } from "./plugin.config";
import { PluginInstaller } from "./plugin.installer";
import { loadPluginManifest, resolvePluginEntry, resolvePluginUiSchemas, validatePluginConfig } from "./plugin.manifest";
import type { PluginRegistry } from "./plugin.registry";
import { buildPluginRuntime, isReelVaultPlugin, type LoadedPluginManifest, toLifecycleError } from "./plugin-loader.utils";
import { clearPluginRuntimes, materializePluginRuntime, pluginRuntimeRoot } from "./plugin-runtime.service";
import { ensurePluginSdkShim } from "./plugin-sdk-alias.utils";

export class PluginLoader {
	readonly logger = createLogger("PluginLoader");
	private readonly config: PluginConfig;
	private readonly registry: PluginRegistry;
	private readonly pluginsDirectory: string;
	private readonly runtimeRoot: string;
	private readonly directoryIndex = new PluginDirectoryIndex();
	private readonly pluginScopes = new Map<string, PluginScope>();
	/** One lockfile store: a new one per lookup re-read the file from disk. */
	private readonly lockfileStore: PluginLockfileStore;

	constructor(config: PluginConfig, registry: PluginRegistry, pluginsDirectory = serverConfig.paths.plugins) {
		this.config = config;
		this.registry = registry;
		this.pluginsDirectory = pluginsDirectory;
		this.runtimeRoot = pluginRuntimeRoot(pluginsDirectory);
		this.lockfileStore = new PluginLockfileStore(pluginsDirectory);
	}

	/** Materialised module-graph directory of a currently loaded plugin, if any. */
	getRuntimeDirectory(pluginId: string): string | undefined {
		return this.pluginScopes.get(pluginId)?.getRuntimeDirectory();
	}

	/** Resolves a plugin id to its directory name via the lockfile record, then the id→directory index. */
	async findDirectoryNameForPluginId(pluginId: string): Promise<string | undefined> {
		// The lockfile records where the installer actually put the plugin; a
		// manifest scan can also see stale duplicate directories with the same id.
		const lockfile = await this.lockfileStore.read();
		const resolved = await resolvePluginDirectoryName(pluginId, lockfile, this.pluginsDirectory);
		if (resolved) {
			this.directoryIndex.set(pluginId, resolved);

			return resolved;
		}

		return await this.directoryIndex.resolve(pluginId, this.pluginsDirectory);
	}

	async loadAll(): Promise<void> {
		// Must precede the first entry import: plugin code imports the SDK by package name.
		await ensurePluginSdkShim(this.pluginsDirectory);
		// Boot / reload-all: stale mirrors from a crash are safe to drop before materialising fresh ones.
		await clearPluginRuntimes(this.runtimeRoot);
		await pluginBlobsService.purgeExpired();
		// The index scans the plugins root and reads the manifests; it hands back
		// the directory names, so the root is not scanned a second time.
		const pluginNames = await this.directoryIndex.refresh(this.pluginsDirectory);
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

		const results = await mapConcurrent(
			loadableNames,
			serverConfig.plugins.lifecycle.loadConcurrency,
			async (name): Promise<PromiseSettledResult<void>> => {
				try {
					await withTimeout(this.load(name), serverConfig.plugins.lifecycle.loadTimeoutMs);

					return { status: "fulfilled", value: undefined };
				} catch (error) {
					return { status: "rejected", reason: error };
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

	/** Directory for a plugin given by directory name or manifest id; a manifest id resolves through the index instead of a rescan. */
	private async resolvePluginDirectory(pluginNameOrId: string): Promise<{ pluginDir: string; pluginName: string }> {
		let pluginDir = joinPath(this.pluginsDirectory, pluginNameOrId);
		let pluginName = pluginNameOrId;

		if (!(await directoryExists(pluginDir))) {
			// Not a directory name — resolve by manifest id through the index instead of rescanning.
			const resolvedName = await this.findDirectoryNameForPluginId(pluginNameOrId);
			if (resolvedName) {
				pluginName = resolvedName;
				pluginDir = joinPath(this.pluginsDirectory, resolvedName);
			}
		}

		return { pluginDir, pluginName };
	}

	/** Loads the optional ui.json into the scope; a malformed manifest skips UI contributions, not the plugin. */
	private async loadUiManifest(pluginDir: string, scope: PluginScope): Promise<void> {
		const uiManifestPath = joinPath(pluginDir, "ui.json");
		const uiManifestRaw = await readJsonFile<unknown>(uiManifestPath, { silent: true });
		if (uiManifestRaw === null) return;

		try {
			validatePluginUiManifest(uiManifestRaw);
			// Inline schemaRef files so the client receives renderable schemas.
			scope.setUiManifest(await resolvePluginUiSchemas(pluginDir, uiManifestRaw));
		} catch (error) {
			// ui.json is optional — a malformed manifest skips UI contributions, not the plugin.
			this.logger.warn("Skipping invalid plugin ui.json", { pluginDir, error: errorMessage(error) });
		}
	}

	/** Imports the plugin entry from its runtime copy and checks that its default export is a ReelVault plugin. */
	private async importPlugin(manifest: LoadedPluginManifest, runtimeDirectory: string): Promise<ReelVaultPlugin> {
		this.registry.markPhase(manifest.id, "entry");
		const entryPath = resolvePluginEntry(runtimeDirectory, manifest);
		this.registry.advance(manifest.id, "resolved", "entry");
		this.registry.markPhase(manifest.id, "import");
		const module: unknown = await import(pathToFileURL(entryPath).href);
		const defaultExport = isRecord(module) ? module.default : undefined;
		if (!defaultExport) {
			throw new DomainError("validation", `Plugin ${manifest.id} is missing a default export`, {
				code: "plugin.export_missing",
				params: { plugin: manifest.id },
			});
		}

		if (!isReelVaultPlugin(defaultExport))
			throw new DomainError("validation", `Plugin ${manifest.id} has an invalid default export`, {
				code: "plugin.export_invalid",
				params: { plugin: manifest.id },
			});

		return defaultExport;
	}

	async load(pluginNameOrId: string): Promise<void> {
		// Keep the SDK shim current on every load — catalog-installed plugins ship without node_modules.
		await ensurePluginSdkShim(this.pluginsDirectory);

		// Never join an unvalidated identifier: a `..%2F` path param must not escape the plugins directory.
		if (!PLUGIN_IDENTIFIER_PATTERN.test(pluginNameOrId)) {
			throw new DomainError("validation", "Invalid plugin identifier", { code: "plugin.invalid_identifier" });
		}

		const { pluginDir, pluginName } = await this.resolvePluginDirectory(pluginNameOrId);

		// Defense in depth — the resolved directory must stay inside the plugins root.
		if (!isSubpath(pluginDir, this.pluginsDirectory)) {
			throw new DomainError("validation", "Invalid plugin directory", { code: "plugin.invalid_identifier" });
		}

		// A package whose manifest could not be read is listed under its directory name; a retry starts clean.
		this.registry.clearFailure(pluginName);

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

			await this.loadUiManifest(pluginDir, scope);

			plugin = await this.importPlugin(manifest, runtimeDirectory);

			// Parse the stored values through the plugin's own config schema before setup() sees them.
			configDefinition = isRecord(plugin) && isConfigDefinition(plugin.config) ? plugin.config : undefined;

			const config = validatePluginConfig(rawConfig, configDefinition);
			this.registry.markPhase(manifest.id, "setup");

			const pluginLogger = createLogger(`Plugin:${manifest.id}`);
			scope.setDeclaredCapabilities(manifest.capabilities);
			// Bind the id before setup(): host capabilities usable during setup
			// (notification channels) need the namespace, not just lifecycle hooks.
			scope.bindPluginId(manifest.id);

			await plugin.setup(createPluginHost(manifest.id, pluginLogger, config, scope));
			scope.assertDeclaredCapabilities(manifest.capabilities);
			this.registry.advance(manifest.id, "initialized", "initialization");

			await scope.initializeProviders(config);
			await scope.registerJobs(manifest.id);
			scope.registerHttpRoutes(manifest.id);
			this.registry.markPhase(manifest.id, "activation");

			const runtime = buildPluginRuntime(manifest, plugin, configDefinition, scope);
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
		} catch (error) {
			await scope.cleanup();
			await this.runFailedLoadUnload(plugin, trackedPluginId);
			failurePhase = this.recordLoadFailure({ trackedPluginId, manifest, pluginName, failurePhase, configDefinition }, error);

			this.logger.error(`Failed to load plugin ${pluginName}`, error, { failurePhase });
			throw error;
		}
	}

	/** A partially-initialized plugin may have opened timers/sockets during setup(), so its unload hook still runs. */
	private async runFailedLoadUnload(plugin: ReelVaultPlugin | undefined, trackedPluginId: string | undefined): Promise<void> {
		if (!plugin?.onUnload) return;

		try {
			await plugin.onUnload();
		} catch (unloadError) {
			this.logger.warn("Plugin onUnload failed during load error cleanup", {
				pluginId: trackedPluginId,
				error: errorMessage(unloadError),
			});
		}
	}

	/** Records a failed load in the registry; returns the phase the failure happened in. */
	private recordLoadFailure(
		attempt: {
			trackedPluginId: string | undefined;
			manifest: LoadedPluginManifest | undefined;
			pluginName: string;
			failurePhase: PluginLoadPhase | undefined;
			configDefinition: ConfigDefinition | undefined;
		},
		err: unknown,
	): PluginLoadPhase | undefined {
		const { trackedPluginId, manifest, pluginName, failurePhase, configDefinition } = attempt;
		if (trackedPluginId) {
			this.registry.fail(trackedPluginId, err, configDefinition);
			const phase = this.registry.get(trackedPluginId)?.failurePhase;
			this.forget(trackedPluginId, true);

			return phase;
		}

		if (manifest) {
			this.registry.recordFailure(manifest, err, failurePhase, configDefinition);
		} else {
			// plugin.json missing or invalid: without this the admin saw nothing at all for a broken package.
			this.registry.recordFailure({ id: pluginName, name: pluginName, version: "unknown" }, err, "manifest");
		}

		return failurePhase;
	}

	/** Drops a plugin from the registry, the directory index and its scope. */
	private forget(pluginId: string, preserveFailure = false): void {
		this.registry.unregister(pluginId, preserveFailure);
		this.directoryIndex.delete(pluginId);
		this.pluginScopes.delete(pluginId);
	}

	async reloadPlugin(pluginId: string): Promise<void> {
		const pluginName = (await this.findDirectoryNameForPluginId(pluginId)) ?? pluginId;

		await this.unloadPlugin(pluginId);
		await this.load(pluginName);
	}

	async unloadPlugin(pluginId: string): Promise<void> {
		const runtime = this.registry.get(pluginId);
		if (!runtime) {
			this.forget(pluginId);

			return;
		}

		if (runtime.state === "failed" || !runtime.plugin) {
			try {
				await this.pluginScopes.get(pluginId)?.cleanup();
			} catch {
				// A failed plugin's cleanup errors were already recorded in the registry.
			}

			this.forget(pluginId);

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
			this.forget(pluginId);
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

		await mapConcurrent(pluginIds, serverConfig.plugins.lifecycle.disposeConcurrency, async (pluginId) => {
			try {
				await withTimeout(this.unloadPlugin(pluginId), serverConfig.plugins.lifecycle.unloadTimeoutMs, `Unload of ${pluginId}`);
			} catch (error) {
				this.logger.error("Plugin failed to unload cleanly during shutdown", error, { pluginId });
			}
		});
	}

	/**
	 * Unloads a plugin and drains its workers ahead of an uninstall. Split from
	 * `removePluginData` so the package directory can be removed first: if that
	 * fails, the plugin is still installed and its data must survive.
	 */
	async prepareUninstall(pluginId: string): Promise<void> {
		// Capture job ids before unloading so in-flight handlers can be drained first.
		// Namespaced worker ids only — raw job names could match core workers.
		const jobNames = this.pluginScopes.get(pluginId)?.getRegisteredJobIds() ?? [];
		await this.unloadPlugin(pluginId);
		try {
			await workerService.drainWorkers(jobNames, serverConfig.plugins.lifecycle.unloadTimeoutMs);
		} catch (error) {
			// Bounded drain: proceed with removal even if a handler ignored its abort.
			this.logger.warn("Plugin job drain failed before data removal", { pluginId, error: errorMessage(error) });
		}

		this.directoryIndex.delete(pluginId);
	}

	/** Removes the plugin's stored data; called after its package directory is gone. */
	async removePluginData(pluginId: string): Promise<void> {
		await Promise.all([
			pluginStorageService.removeForPlugin(pluginId),
			pluginBlobsService.removeForPlugin(pluginId),
			pluginArtifactsService.removeForPlugin(pluginId),
		]);
		this.logger.info(`Plugin ${pluginId} data removed`);
	}
}
