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
	PluginScheduledTaskDefinition,
	PluginUiManifest,
	SubtitleProvider,
} from "@sdk/plugin";
import { serverConfig } from "@/server.config";
import { errorMessage, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PromiseUtils } from "@/utils/promise.utils";
import { scheduledTasksService } from "@/workers/scheduled-tasks.service";
import { guardedPluginFetch } from "../../capabilities/plugin.http";
import {
	enqueuePluginJob,
	enqueuePluginJobs,
	registerPluginJobs,
	unregisterPluginJobs,
	validatePluginJobSchedule,
} from "../../capabilities/plugin.jobs";
import { pluginAccessBus } from "../../runtime/plugin.access";
import { pluginEventBus } from "../../runtime/plugin.events";
import { pluginHookBus } from "../../runtime/plugin.hooks";
import { pluginRoutesRegistry } from "../../runtime/plugin.routes";
import { assertDeclaredPluginCapabilities } from "../plugin.manifest";
import { removePluginRuntime } from "../plugin-runtime-copy";

export interface PluginScopeApi {
	useCapability(name: PluginCapabilityName): void;
	addAnalyzer(analyzer: MediaAnalyzer): void;
	addProvider(provider: MetadataProvider): void;
	addSubtitleProvider(provider: SubtitleProvider): void;
	addJob(definition: PluginJobDefinition): void;
	addScheduledTask(task: PluginScheduledTaskDefinition): void;
	addHttpRoute(route: PluginHttpRoute): void;
	enqueueJob(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle>;
	enqueueJobs(pluginId: string, name: string, items: unknown[], options?: PluginEnqueueOptions): Promise<PluginJobHandle[]>;
	/** Contravariant handler erase: accepts every typed event handler while staying assignable to the bus. */
	subscribe(pluginId: string, event: PluginEventName, handler: PluginEventHandlerErased): void;
	subscribeBeforeArtifactCreate(pluginId: string, handler: BeforeArtifactCreateHook): void;
	subscribeBeforeMediaRecognition(pluginId: string, handler: BeforeMediaRecognitionHook): void;
	subscribeBeforeMetadataSave(pluginId: string, handler: BeforeMetadataSaveHook): void;
	subscribeAccessPolicy(pluginId: string, policy: PluginAccessPolicy): void;
}

export type PluginEventHandlerErased = (payload: never) => void | Promise<void>;

export class PluginScope {
	private readonly logger = createLogger("PluginScope");
	private readonly providers: MetadataProvider[] = [];
	private readonly providerIds = new Set<string>();
	private readonly subtitleProviders: SubtitleProvider[] = [];
	private readonly subtitleProviderIds = new Set<string>();
	private readonly analyzers: MediaAnalyzer[] = [];
	private readonly analyzerIds = new Set<string>();
	private readonly jobs: PluginJobDefinition[] = [];
	private readonly httpRoutes: PluginHttpRoute[] = [];
	private readonly jobNames = new Set<string>();
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
			throw new ValidationError(`Plugin uses capability '${capability}' that is missing from plugin.json`);
		}

		this.usedCapabilities.add(capability);
	}

	assertDeclaredCapabilities(declaredCapabilities: readonly PluginCapabilityName[]): void {
		assertDeclaredPluginCapabilities(declaredCapabilities, this.usedCapabilities);
	}

	addProvider(provider: MetadataProvider): void {
		registerEntity(this.providers, provider, "provider", this.providerIds);
	}

	addSubtitleProvider(provider: SubtitleProvider): void {
		registerEntity(this.subtitleProviders, provider, "subtitle provider", this.subtitleProviderIds);
	}

	addAnalyzer(analyzer: MediaAnalyzer): void {
		registerEntity(this.analyzers, analyzer, "media analyzer", this.analyzerIds);
	}

	private readonly scheduledTasks: PluginScheduledTaskDefinition[] = [];

	addScheduledTask(task: PluginScheduledTaskDefinition): void {
		if (!(task.id && task.name)) {
			throw new ValidationError("Plugin scheduled task must have id and name");
		}

		this.scheduledTasks.push(task);
	}

	addJob(job: PluginJobDefinition): void {
		if (!job.name) {
			throw new ValidationError("Plugin job name must be non-empty");
		}

		validatePluginJobSchedule(job);
		if (this.jobNames.has(job.name)) {
			throw new ValidationError(`Plugin job ${job.name} is registered more than once`);
		}

		this.jobs.push(job);
		this.jobNames.add(job.name);
	}

	addHttpRoute(route: PluginHttpRoute): void {
		const routeKey = `${route.method}:${route.path}`;
		if (this.routeKeys.has(routeKey)) {
			throw new ValidationError(`Plugin HTTP route ${route.method} ${route.path} is registered more than once`);
		}

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
		await PromiseUtils.mapConcurrent(this.providers, concurrency, initialize);
		await PromiseUtils.mapConcurrent(this.subtitleProviders, concurrency, initialize);
	}

	async registerJobs(pluginId: string): Promise<void> {
		this.pluginId = pluginId;
		if (this.jobs.length > 0) {
			const names = await registerPluginJobs(pluginId, this.jobs);
			for (const name of names) this.jobNames.add(name);
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
				throw new ValidationError(`Plugin '${pluginId}' scheduled task registration failed: ${message}`);
			}
		}
	}

	registerHttpRoutes(pluginId: string): void {
		pluginRoutesRegistry.register(pluginId, this.httpRoutes);
		this.pluginId = pluginId;
	}

	async enqueueJob(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle> {
		if (!this.jobNames.has(name)) {
			throw new ValidationError(`Plugin job ${name} is not registered`);
		}

		return await enqueuePluginJob(pluginId, name, data, options);
	}

	async enqueueJobs(
		pluginId: string,
		name: string,
		items: Array<{ data: unknown; options?: PluginEnqueueOptions }>,
		commonOptions?: { operationId?: string; reference?: { type: string; id: string } },
	): Promise<PluginJobHandle[]> {
		if (!this.jobNames.has(name)) {
			throw new ValidationError(`Plugin job ${name} is not registered`);
		}

		return await enqueuePluginJobs(pluginId, name, items, commonOptions);
	}

	getProviders(): readonly MetadataProvider[] {
		return this.providers;
	}

	getAnalyzers(): readonly MediaAnalyzer[] {
		return this.analyzers;
	}

	getSubtitleProviders(): readonly SubtitleProvider[] {
		return this.subtitleProviders;
	}

	getProviderIds(): string[] {
		return this.providers.map((provider) => provider.id);
	}

	getAnalyzerIds(): string[] {
		return this.analyzers.map((analyzer) => analyzer.id);
	}

	getSubtitleProviderIds(): string[] {
		return this.subtitleProviders.map((provider) => provider.id);
	}

	getJobNames(): string[] {
		return [...this.jobNames];
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

	async cleanup(): Promise<void> {
		for (const unsubscribe of this.unsubscribers.toReversed()) unsubscribe();

		await removePluginRuntime(this.runtimeDirectory);
		this.runtimeDirectory = undefined;
		if (this.pluginId) {
			pluginRoutesRegistry.unregisterPlugin(this.pluginId);
			scheduledTasksService.unregisterByPlugin(this.pluginId);
		}

		if (this.jobNames.size > 0) {
			unregisterPluginJobs([...this.jobNames]);
		}

		await PromiseUtils.mapConcurrent(
			[...this.providers, ...this.subtitleProviders, ...this.analyzers].toReversed(),
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

function registerEntity<T extends { id: string; name: string; version: string }>(
	collection: T[],
	entity: T,
	label: string,
	knownIds: Set<string>,
): void {
	if (!(entity.id && entity.name && entity.version)) {
		throw new ValidationError(`Plugin ${label} must have id, name and version`);
	}

	if (knownIds.has(entity.id)) {
		throw new ValidationError(`Plugin ${label} ${entity.id} is registered more than once`);
	}

	knownIds.add(entity.id);
	collection.push(entity);
}
