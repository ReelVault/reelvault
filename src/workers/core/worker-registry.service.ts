import type { WorkerDefinition } from "@sdk/common";
import { serverConfig } from "@/server.config";
import { resourceAllocator } from "@/system/resource-allocator";
import { serverRescueService } from "@/system/server-rescue.service";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { ConflictError } from "@/utils/errors";

export class WorkerRegistryService extends BaseService {
	private readonly definitions = new Map<string, WorkerDefinition>();

	constructor() {
		super("WorkerRegistryService");
	}

	register<TData = unknown, TResult = unknown>(definition: WorkerDefinition<TData, TResult>): void {
		if (this.definitions.has(definition.id)) {
			throw new ConflictError(`Worker "${definition.id}" is already registered`);
		}

		this.definitions.set(definition.id, this.normalizeDefinition(definition));
		this.logger.debug("Worker registered", { id: definition.id, category: definition.category });
	}

	unregister(workerId: string): boolean {
		return this.definitions.delete(workerId);
	}

	get(workerId: string): WorkerDefinition | undefined {
		return this.definitions.get(workerId);
	}

	has(workerId: string): boolean {
		return this.definitions.has(workerId);
	}

	getAll(): WorkerDefinition[] {
		return [...this.definitions.values()];
	}

	get size(): number {
		return this.definitions.size;
	}

	private normalizeDefinition<TData, TResult>(
		definition: WorkerDefinition<TData, TResult>,
	): WorkerDefinition<TData, TResult> & Required<Pick<WorkerDefinition<TData, TResult>, "concurrency" | "timeoutMs">> {
		return {
			...definition,
			get concurrency() {
				// Server rescue overrides even explicitly configured concurrency (fixed
				// definitions like library-scan hardcode concurrency > 0); playback
				// workers are exempt and fall through to the normal path.
				const rescueAllocation = serverRescueService.getRescueAllocation(definition.id);
				if (rescueAllocation) return rescueAllocation.allocated;

				const val = definition.concurrency;
				// Clamp explicit/admin concurrency to the absolute ceiling — otherwise a
				// value above WORKER_MAX_CONCURRENCY bypassed the allocator entirely.
				if (val !== undefined && val > 0) return Math.min(val, resourceAllocator.getWorkerConcurrencyCeiling(definition.id));

				return resourceAllocator.getWorkerAllocation(definition.id).allocated;
			},
			get timeoutMs() {
				// Wall-clock budgets need headroom on slow single cores — a 10-minute
				// image batch that fits a modern CPU can time out spuriously on
				// E5/RPi-class hardware. Fast boxes keep the base unchanged.
				return systemResourcesService.scaledTimeoutMs(
					Math.max(1, definition.timeoutMs ?? serverConfig.workers.scheduling.defaultTimeoutMs),
				);
			},
			get attempts() {
				return Math.max(1, definition.attempts ?? serverConfig.workers.scheduling.defaultAttempts);
			},
			get backoff() {
				return definition.backoff ?? serverConfig.workers.scheduling.defaultBackoff;
			},
		};
	}
}
