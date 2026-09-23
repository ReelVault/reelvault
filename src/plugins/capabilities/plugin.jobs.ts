import type { PluginEnqueueOptions, PluginJobDefinition, PluginJobHandle } from "@sdk/plugin";
import { resourceAllocator } from "@/system/resource-allocator";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { clamp } from "@/utils/math.utils";
import { isNonEmptyString } from "@/utils/type.utils";
import { workerOperationsService } from "@/workers/core/worker-operations.service";
import { assertCronExpression } from "@/workers/utils/worker-policy.utils";
import { workerService } from "@/workers/worker.service";

/** Absolute cap on a plugin-declared job timeout (24h) — a job must not stall a slot forever. */
const MAX_PLUGIN_JOB_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function clampPluginJobConcurrency(workerId: string, value: number | undefined): number | undefined {
	if (value === undefined) return undefined;

	return clamp(Math.floor(value), 1, resourceAllocator.getWorkerConcurrencyCeiling(workerId));
}

function clampPluginJobTimeout(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;

	return clamp(Math.floor(value), 1, MAX_PLUGIN_JOB_TIMEOUT_MS);
}

class PluginJobsService extends BaseService {
	constructor() {
		super("PluginJobsService");
	}

	namespace(pluginId: string, jobName: string): string {
		return `${pluginId}:${jobName}`;
	}

	validateSchedule(job: PluginJobDefinition): void {
		if (job.schedule?.cron) assertCronExpression(job.schedule.cron);
	}

	register(pluginId: string, jobs: readonly PluginJobDefinition[]): Promise<string[]> {
		const names: string[] = [];
		try {
			for (const job of jobs) {
				if (typeof job !== "object") {
					throw new ValidationError(`Plugin '${pluginId}' job registration failed: job definition must be an object.`);
				}

				if (!job.name || typeof job.name !== "string") {
					throw new ValidationError(`Plugin '${pluginId}' job registration failed: 'name' is required.`);
				}

				if (typeof job.handler !== "function") {
					throw new ValidationError(`Plugin '${pluginId}' job '${job.name}' is missing a valid 'handler' function.`);
				}

				this.validateSchedule(job);

				const name = this.namespace(pluginId, job.name);
				workerService.registerWorker({
					id: name,
					name: job.title ?? job.name,
					description: job.description,
					category: "plugins",
					defaultTriggers: job.schedule?.defaultTriggers,
					concurrency: clampPluginJobConcurrency(name, job.options?.concurrency),
					timeoutMs: clampPluginJobTimeout(job.options?.timeoutMs),
					attempts: job.options?.attempts,
					backoff: job.options?.backoff,
					removeOnComplete: job.options?.removeOnComplete,
					removeOnFail: job.options?.removeOnFail,
					schedule: job.schedule?.cron ? { cron: job.schedule.cron, data: job.schedule.data } : undefined,
					handler: async (item) =>
						await job.handler({
							taskId: item.taskId,
							name: job.name,
							data: item.data,
							attempt: item.attempt,
							signal: item.signal,
							logger: item.logger,
							operationId: item.operationId,
							updateProgress: item.updateProgress,
						}),
				});
				names.push(name);
			}

			return Promise.resolve(names);
		} catch (error) {
			// Roll back the jobs registered before the failure — otherwise they leak
			// (the caller never receives the partial name list to clean up).
			this.unregister(names);
			throw error;
		}
	}

	async enqueue(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle> {
		if (!isNonEmptyString(name)) {
			throw new ValidationError(`Plugin '${pluginId}' failed to enqueue job: 'name' must be a non-empty string.`);
		}

		const namespacedName = this.namespace(pluginId, name);
		let operationId = options?.operationId;
		let createdOperation = false;
		if (!operationId) {
			const op = await workerOperationsService.create({
				type: namespacedName,
				reference: options?.reference ?? { type: "plugin", id: pluginId },
			});
			operationId = op.id;
			createdOperation = true;
		}

		try {
			const queuedItem = await workerService.addItem(namespacedName, data, {
				...options,
				operationId,
			});

			return { id: queuedItem.id, name, operationId };
		} catch (error) {
			if (createdOperation)
				await workerOperationsService.remove(operationId).catch(() => {
					// intentionally empty
				});

			throw error;
		}
	}

	async enqueueMany(
		pluginId: string,
		name: string,
		items: Array<{ data: unknown; options?: PluginEnqueueOptions }>,
		commonOptions?: { operationId?: string; reference?: { type: string; id: string } },
	): Promise<PluginJobHandle[]> {
		if (!isNonEmptyString(name)) {
			throw new ValidationError(`Plugin '${pluginId}' failed to enqueue jobs: 'name' must be a non-empty string.`);
		}

		if (items.length === 0) return [];

		const namespacedName = this.namespace(pluginId, name);
		let operationId = commonOptions?.operationId;
		let createdOperation = false;
		if (!operationId) {
			const op = await workerOperationsService.create({
				type: namespacedName,
				reference: commonOptions?.reference ?? { type: "plugin", id: pluginId },
			});
			operationId = op.id;
			createdOperation = true;
		}

		const entries = items.map((item) => ({
			data: item.data,
			options: {
				...item.options,
				operationId: item.options?.operationId ?? operationId,
			},
		}));

		try {
			const queuedItems = await workerService.addItems(namespacedName, entries);

			return queuedItems.map((item) => ({ id: item.id, name, operationId }));
		} catch (error) {
			// addItems is not atomic across the whole batch — clean up the operation
			// (and any jobs already inserted under it) so nothing is orphaned.
			if (createdOperation) {
				await workerService.cancelAllPending(operationId).catch(() => {
					// intentionally empty
				});
				await workerOperationsService.remove(operationId).catch(() => {
					// intentionally empty
				});
			}

			throw error;
		}
	}

	unregister(names: readonly string[]): void {
		for (const name of [...names].toReversed()) workerService.unregisterWorker(name);
	}
}

const pluginJobsService = new PluginJobsService();

export function namespacePluginJobName(pluginId: string, jobName: string): string {
	return pluginJobsService.namespace(pluginId, jobName);
}

export function validatePluginJobSchedule(job: PluginJobDefinition): void {
	pluginJobsService.validateSchedule(job);
}

export function registerPluginJobs(pluginId: string, jobs: readonly PluginJobDefinition[]): Promise<string[]> {
	return pluginJobsService.register(pluginId, jobs);
}

export function enqueuePluginJob(pluginId: string, name: string, data: unknown, options?: PluginEnqueueOptions): Promise<PluginJobHandle> {
	return pluginJobsService.enqueue(pluginId, name, data, options);
}

export function enqueuePluginJobs(
	pluginId: string,
	name: string,
	items: Array<{ data: unknown; options?: PluginEnqueueOptions }>,
	commonOptions?: { operationId?: string; reference?: { type: string; id: string } },
): Promise<PluginJobHandle[]> {
	return pluginJobsService.enqueueMany(pluginId, name, items, commonOptions);
}

export function unregisterPluginJobs(names: readonly string[]): void {
	pluginJobsService.unregister(names);
}
