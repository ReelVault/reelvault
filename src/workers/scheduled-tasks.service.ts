import type { ScheduledTaskCategory, TaskTrigger } from "@sdk/common";
import { workerService } from "./worker.service";

class ScheduledTasksAdapter {
	async init(): Promise<void> {
		await workerService.scheduler.init();
	}

	register(task: {
		id: string;
		category: ScheduledTaskCategory;
		defaultTriggers: TaskTrigger[];
		run: () => Promise<string | undefined>;
	}): Promise<void> {
		workerService.registerWorker({
			id: task.id,
			category: task.category,
			defaultTriggers: task.defaultTriggers,
			handler: async () => {
				const opId = await task.run();

				return { operationId: opId };
			},
		});

		return Promise.resolve();
	}

	unregisterByPlugin(pluginId: string): void {
		for (const def of workerService.getDefinitions()) {
			if (def.id.startsWith(`${pluginId}:`) || def.id === pluginId) {
				workerService.unregisterWorker(def.id);
			}
		}
	}
}

export const scheduledTasksService = new ScheduledTasksAdapter();
