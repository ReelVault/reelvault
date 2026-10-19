import type {
	BeforeArtifactCreateHook,
	BeforeMediaRecognitionHook,
	BeforeMetadataSaveHook,
	MediaAnalyzer,
	MetadataProvider,
	PluginAccessPolicy,
	PluginCapabilityName,
	PluginEnqueueOptions,
	PluginEventName,
	PluginHost,
	PluginHttpRoute,
	PluginJobDefinition,
	PluginJobHandle,
	PluginNotificationChannel,
	PluginScheduledTaskDefinition,
	PluginUiManifest,
	SubtitleProvider,
} from "@reelvault/sdk/plugin";
import { serverConfig } from "@/config/server/server.config";
import { guardedPluginFetch } from "@/plugins/capabilities/plugin.http";
import { type PluginJobBatchItem, type PluginJobBatchOptions, pluginJobsService } from "@/plugins/capabilities/plugin.jobs";
import { assertDeclaredPluginCapabilities } from "@/plugins/lifecycle/plugin.manifest";
import { removePluginRuntime } from "@/plugins/lifecycle/plugin-runtime.service";
import { PluginEntityTable } from "@/plugins/lifecycle/registry/plugin-entity.registry";
import { registerNotificationChannel } from "@/plugins/runtime/notification-channel.registry";
import { pluginAccessBus } from "@/plugins/runtime/plugin.access";
import { pluginRoutesRegistry } from "@/plugins/runtime/plugin.routes";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { pluginHookBus } from "@/system/extensions/plugin.hooks";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { scheduledTasksService } from "@/workers/scheduled-tasks.service";

export interface PluginScopeApi {
	useCapability(name: PluginCapabilityName): void;
	registerNotificationChannelScope(channel: PluginNotificationChannel): void;
	addAnalyzer(analyzer: MediaAnalyzer): void;
	addProvider(provider: MetadataProvider): void;
	addSubtitleProvider(provider: SubtitleProvider): void;
	addJob(definition: PluginJobDefinition): void;
	addScheduledTask(task: PluginScheduledTaskDefinition): void;
	addHttpRoute(route: PluginHttpRoute): void;
	enqueueJob(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle>;
	enqueueJobs(
		pluginId: string,
		name: string,
		items: PluginJobBatchItem[],
		commonOptions?: PluginJobBatchOptions,
	): Promise<PluginJobHandle[]>;
	/** Contravariant handler erase: accepts every typed event handler while staying assignable to the bus. */
	subscribe(pluginId: string, event: PluginEventName, handler: PluginEventHandlerErased): void;
	subscribeBeforeArtifactCreate(pluginId: string, handler: BeforeArtifactCreateHook): void;
	subscribeBeforeMediaRecognition(pluginId: string, handler: BeforeMediaRecognitionHook): void;
	subscribeBeforeMetadataSave(pluginId: string, handler: BeforeMetadataSaveHook): void;
	subscribeAccessPolicy(pluginId: string, policy: PluginAccessPolicy): void;
}

export type PluginEventHandlerErased = (payload: never) => void | Promise<void>;

export class PluginScope {
	readonly logger = createLogger("PluginScope");
	private readonly providers = new PluginEntityTable<MetadataProvider>("provider");
	private readonly subtitleProviders = new PluginEntityTable<SubtitleProvider>("subtitle provider");
	private readonly analyzers = new PluginEntityTable<MediaAnalyzer>("media analyzer");
	private readonly jobs: PluginJobDefinition[] = [];
	private readonly httpRoutes: PluginHttpRoute[] = [];
	/** Raw plugin-declared job names (duplicate checks and enqueue guards). */
	private readonly jobNames = new Set<string>();
	/** Namespaced worker ids registered for this scope — the only ids teardown may unregister. */
	private readonly registeredJobIds = new Set<string>();
	private readonly routeKeys = new Set<string>();
	private readonly unsubscribers: Array<() => void> = [];
	private readonly usedCapabilities = new Set<PluginCapabilityName>();
	private declaredCapabilities: ReadonlySet<PluginCapabilityName> | null = null;
	private uiManifestData?: PluginUiManifest | undefined;
	private pluginId?: string | undefined;
	private runtimeDirectory?: string | undefined;

	setRuntimeDirectory(directory: string): void {
		this.runtimeDirectory = directory;
	}

	getRuntimeDirectory(): string | undefined {
		return this.runtimeDirectory;
	}

	setDeclaredCapabilities(capabilities: readonly PluginCapabilityName[]): void {
		this.declaredCapabilities = new Set(capabilities);
	}

	useCapability(capability: PluginCapabilityName): void {
		// Fail fast: a missing declaration must stop real side effects at registration time.
		if (this.declaredCapabilities && !this.declaredCapabilities.has(capability)) {
			throw new DomainError("validation", `Plugin uses capability '${capability}' that is missing from plugin.json`, {
				code: "plugin.capability_undeclared",
				params: { capability },
			});
		}

		this.usedCapabilities.add(capability);
	}

	assertDeclaredCapabilities(declaredCapabilities: readonly PluginCapabilityName[]): void {
		assertDeclaredPluginCapabilities(declaredCapabilities, this.usedCapabilities);
	}

	/** Refuses one more registration once the plugin reaches its cap; the code names the kind of entry for the admin. */
	private assertUnderLimit(code: string, registered: number, limit: number): void {
		if (registered < limit) return;

		throw new DomainError("validation", `Plugin registration limit of ${limit} reached (${code})`, { code, params: { limit } });
	}

	addProvider(provider: MetadataProvider): void {
		this.assertUnderLimit(
			"plugin.registration_limit.providers",
			this.providers.getAll().length,
			serverConfig.plugins.registration.maxHandlers,
		);
		this.providers.register(undefined, [provider]);
	}

	addSubtitleProvider(provider: SubtitleProvider): void {
		this.assertUnderLimit(
			"plugin.registration_limit.subtitle_providers",
			this.subtitleProviders.getAll().length,
			serverConfig.plugins.registration.maxHandlers,
		);
		this.subtitleProviders.register(undefined, [provider]);
	}

	addAnalyzer(analyzer: MediaAnalyzer): void {
		this.assertUnderLimit(
			"plugin.registration_limit.analyzers",
			this.analyzers.getAll().length,
			serverConfig.plugins.registration.maxHandlers,
		);
		this.analyzers.register(undefined, [analyzer]);
	}

	private readonly scheduledTasks: PluginScheduledTaskDefinition[] = [];

	addScheduledTask(task: PluginScheduledTaskDefinition): void {
		if (!(task.id && task.name)) {
			throw new DomainError("validation", "Plugin scheduled task must have id and name", { code: "plugin.scheduled_task_invalid" });
		}

		this.assertUnderLimit(
			"plugin.registration_limit.scheduled_tasks",
			this.scheduledTasks.length,
			serverConfig.plugins.registration.maxScheduledTasks,
		);
		this.scheduledTasks.push(task);
	}

	addJob(job: PluginJobDefinition): void {
		if (!job.name) {
			throw new DomainError("validation", "Plugin job name must be non-empty", { code: "plugin.job_name_required" });
		}

		pluginJobsService.validateSchedule(job);
		if (this.jobNames.has(job.name)) {
			throw new DomainError("validation", `Plugin job ${job.name} is registered more than once`, {
				code: "plugin.job_duplicate",
				params: { job: job.name },
			});
		}

		this.assertUnderLimit("plugin.registration_limit.jobs", this.jobs.length, serverConfig.plugins.registration.maxJobs);
		this.jobs.push(job);
		this.jobNames.add(job.name);
	}

	addHttpRoute(route: PluginHttpRoute): void {
		const routeKey = `${route.method}:${route.path}`;
		if (this.routeKeys.has(routeKey)) {
			throw new DomainError("validation", `Plugin HTTP route ${route.method} ${route.path} is registered more than once`, {
				code: "plugin.route_duplicate",
				params: { method: route.method, path: route.path },
			});
		}

		this.assertUnderLimit("plugin.registration_limit.routes", this.httpRoutes.length, serverConfig.plugins.registration.maxHttpRoutes);
		this.httpRoutes.push(route);
		this.routeKeys.add(routeKey);
	}

	async initializeProviders(config: PluginHost["config"]): Promise<void> {
		const initialize = async (provider: MetadataProvider | SubtitleProvider): Promise<void> => {
			await provider.initialize({
				logger: createLogger(`Provider:${provider.id}`),
				http: guardedPluginFetch,
				config,
			});
		};
		const concurrency = serverConfig.plugins.lifecycle.loadConcurrency;
		await PromiseUtils.mapConcurrent(this.providers.getAll(), concurrency, initialize);
		await PromiseUtils.mapConcurrent(this.subtitleProviders.getAll(), concurrency, initialize);
	}

	/** Binds the plugin id before setup() so host capabilities used there (e.g. notification channels) can namespace themselves. */
	bindPluginId(pluginId: string): void {
		this.pluginId = pluginId;
	}

	async registerJobs(pluginId: string): Promise<void> {
		this.pluginId = pluginId;
		if (this.jobs.length > 0) {
			const names = await pluginJobsService.register(pluginId, this.jobs);
			for (const name of names) this.registeredJobIds.add(name);
		}

		// Task ids are colon-namespaced so `unregisterByPlugin` always reclaims them on reload.
		for (const task of this.scheduledTasks) {
			const taskId = task.id.startsWith(`${pluginId}:`) ? task.id : `${pluginId}:${task.id}`;
			try {
				await scheduledTasksService.register({
					id: taskId,
					category: "plugins",
					defaultTriggers: task.defaultTriggers ?? [],
					run: task.run,
				});
			} catch (error) {
				const message = errorMessage(error);
				this.logger.error(`Failed to register scheduled task '${task.id}' for plugin '${pluginId}': ${message}`);
				throw new DomainError("validation", `Plugin '${pluginId}' scheduled task registration failed: ${message}`, {
					code: "plugin.scheduled_task_failed",
					params: { plugin: pluginId },
				});
			}
		}
	}

	registerHttpRoutes(pluginId: string): void {
		pluginRoutesRegistry.register(pluginId, this.httpRoutes);
		this.pluginId = pluginId;
	}

	async enqueueJob(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle> {
		if (!this.jobNames.has(name)) {
			throw new DomainError("validation", `Plugin job ${name} is not registered`, {
				code: "plugin.job_not_registered",
				params: { job: name },
			});
		}

		return await pluginJobsService.enqueue(pluginId, name, data, options);
	}

	async enqueueJobs(
		pluginId: string,
		name: string,
		items: PluginJobBatchItem[],
		commonOptions?: PluginJobBatchOptions,
	): Promise<PluginJobHandle[]> {
		if (!this.jobNames.has(name)) {
			throw new DomainError("validation", `Plugin job ${name} is not registered`, {
				code: "plugin.job_not_registered",
				params: { job: name },
			});
		}

		return await pluginJobsService.enqueueMany(pluginId, name, items, commonOptions);
	}

	getProviders(): readonly MetadataProvider[] {
		return this.providers.getAll();
	}

	getAnalyzers(): readonly MediaAnalyzer[] {
		return this.analyzers.getAll();
	}

	getSubtitleProviders(): readonly SubtitleProvider[] {
		return this.subtitleProviders.getAll();
	}

	getProviderIds(): string[] {
		return this.providers.getAll().map((provider) => provider.id);
	}

	getAnalyzerIds(): string[] {
		return this.analyzers.getAll().map((analyzer) => analyzer.id);
	}

	getSubtitleProviderIds(): string[] {
		return this.subtitleProviders.getAll().map((provider) => provider.id);
	}

	/** Raw plugin-declared job names — duplicate checks, enqueue guards and status counts. */
	getJobNames(): string[] {
		return [...this.jobNames];
	}

	/** Namespaced worker ids registered for this scope — the only ids teardown may drain or unregister. */
	getRegisteredJobIds(): string[] {
		return [...this.registeredJobIds];
	}

	setUiManifest(manifest: PluginUiManifest): void {
		this.uiManifestData = manifest;
	}

	getUiManifest(): PluginUiManifest | undefined {
		return this.uiManifestData;
	}

	subscribe(pluginId: string, event: PluginEventName, handler: PluginEventHandlerErased): void {
		this.unsubscribers.push(pluginEventBus.on(pluginId, event, handler));
	}

	subscribeBeforeMetadataSave(pluginId: string, handler: BeforeMetadataSaveHook): void {
		this.unsubscribers.push(pluginHookBus.beforeMetadataSave(pluginId, handler));
	}

	subscribeBeforeMediaRecognition(pluginId: string, handler: BeforeMediaRecognitionHook): void {
		this.unsubscribers.push(pluginHookBus.beforeMediaRecognition(pluginId, handler));
	}

	subscribeBeforeArtifactCreate(pluginId: string, handler: BeforeArtifactCreateHook): void {
		this.unsubscribers.push(pluginHookBus.beforeArtifactCreate(pluginId, handler));
	}

	subscribeAccessPolicy(pluginId: string, policy: PluginAccessPolicy): void {
		this.unsubscribers.push(pluginAccessBus.register(pluginId, policy));
	}

	registerNotificationChannelScope(channel: PluginNotificationChannel): void {
		if (!this.pluginId)
			throw new DomainError("validation", "Notification channel registered before plugin scope bind", { code: "plugin.scope_not_bound" });

		this.unsubscribers.push(registerNotificationChannel(this.pluginId, channel));
	}

	async cleanup(): Promise<void> {
		for (const unsubscribe of this.unsubscribers.toReversed()) unsubscribe();

		await removePluginRuntime(this.runtimeDirectory);
		this.runtimeDirectory = undefined;
		if (this.pluginId) {
			pluginRoutesRegistry.unregisterPlugin(this.pluginId);
			await scheduledTasksService.unregisterByPlugin(this.pluginId);
		}

		if (this.registeredJobIds.size > 0) {
			await pluginJobsService.unregister([...this.registeredJobIds]);
		}

		await PromiseUtils.mapConcurrent(
			[...this.providers.getAll(), ...this.subtitleProviders.getAll(), ...this.analyzers.getAll()].toReversed(),
			serverConfig.plugins.lifecycle.disposeConcurrency,
			async (entity) => {
				try {
					await entity.dispose?.();
				} catch (error) {
					this.logger.error("Plugin capability disposal failed", error, { pluginId: this.pluginId, entityId: entity.id });
				}
			},
		);
	}
}
