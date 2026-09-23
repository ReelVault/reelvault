import { type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import type { ActiveWorkerItem } from "@/database/repositories/worker.repository";
import { BaseService } from "@/utils/base-service";
import { ConflictError, NotFoundError } from "@/utils/errors";
import { enqueueMediaFileTechnicalRefresh } from "@/workers/definitions/media/media-file-technical-refresh.worker";
import { enqueueMetadataRefresh } from "@/workers/definitions/metadata/metadata-refresh.worker";
import { workerService } from "@/workers/worker.service";

type ScheduledTask = ActiveWorkerItem;

export interface MediaFileRefreshOperationDependencies {
	findById(mediaFileId: string): Promise<{ id: string; metadataId: string } | undefined>;
	findActive(workerId: string, dedupeKey: string): Promise<ScheduledTask | undefined>;
	scheduleTechnical(mediaFileId: string, options: TaskSchedulingOptions): Promise<ScheduledTask>;
	scheduleMetadata(data: { metadataId: string }, options: TaskSchedulingOptions): Promise<ScheduledTask>;
}

const defaultDependencies: MediaFileRefreshOperationDependencies = {
	findById: async (mediaFileId) => await mediaRepository.findIdentity(mediaFileId),
	findActive: (workerId, dedupeKey) => workerService.findActiveItem(workerId, dedupeKey),
	scheduleTechnical: enqueueMediaFileTechnicalRefresh,
	scheduleMetadata: (data, options) => enqueueMetadataRefresh(data, options),
};

class MediaFileRefreshService extends BaseService {
	constructor() {
		super("MediaFileRefreshService");
	}

	async queue(
		mediaFileId: string,
		options: TaskSchedulingOptions = {},
		dependencies: MediaFileRefreshOperationDependencies = defaultDependencies,
		knownMetadataId?: string,
	): Promise<{ technicalTask: ScheduledTask; metadataTask: ScheduledTask }> {
		return await this.safeExecute(
			"queue",
			async () => {
				const metadataId = knownMetadataId ?? (await dependencies.findById(mediaFileId))?.metadataId;
				if (!metadataId) {
					throw new NotFoundError(`Media file not found: ${mediaFileId}`);
				}

				const activeTechnical = await dependencies.findActive("media-file-technical-refresh", mediaFileId);
				assertOperationCompatibility(activeTechnical, options.operationId, "technical media refresh");
				const technicalTask = activeTechnical ?? (await dependencies.scheduleTechnical(mediaFileId, options));

				const activeMetadata = await dependencies.findActive("metadata-refresh", metadataId);
				assertOperationCompatibility(activeMetadata, options.operationId, "metadata refresh");
				const metadataTask =
					activeMetadata ??
					(await dependencies.scheduleMetadata(
						{ metadataId },
						{
							...options,
							dependsOnTaskIds: [technicalTask.id],
						},
					));

				return { technicalTask, metadataTask };
			},
			{
				customThrow: (error) => toDomainError(error, `Media file refresh orchestration failed: ${mediaFileId}`),
				logContext: { mediaFileId, operationId: options.operationId },
			},
		);
	}
}

export const mediaFileRefreshService = new MediaFileRefreshService();

function assertOperationCompatibility(task: ScheduledTask | undefined, operationId: string | undefined, label: string): void {
	if (!task || task.operationId === operationId) return;

	throw new ConflictError(`Active ${label} belongs to another operation`);
}
