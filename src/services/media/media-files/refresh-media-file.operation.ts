import { mediaRepository } from "@/repositories/media-files.repository";
import type { ActiveWorkerItem } from "@/repositories/worker.repository";
import { DomainError, toDomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";
import { enqueueMediaFileTechnicalRefresh } from "@/workers/definitions/media/media-file-technical-refresh.worker";
import { enqueueMetadataRefresh } from "@/workers/definitions/metadata/metadata-refresh.worker";
import { assertOperationCompatibility } from "@/workers/utils/operation-compat.guard";
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

export class MediaFileRefreshService {
	readonly serviceName = "MediaFileRefreshService";
	readonly logger = createLogger("MediaFileRefreshService");

	private readonly dependencies: MediaFileRefreshOperationDependencies;

	constructor(dependencies: MediaFileRefreshOperationDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async queue(
		mediaFileId: string,
		options: TaskSchedulingOptions = {},
		knownMetadataId?: string,
	): Promise<{ technicalTask: ScheduledTask; metadataTask: ScheduledTask }> {
		return await runSafely(
			this,
			"queue",
			async () => {
				const metadataId = knownMetadataId ?? (await this.dependencies.findById(mediaFileId))?.metadataId;
				if (!metadataId) {
					throw new DomainError("not_found", `Media file not found: ${mediaFileId}`, { code: "media_file.not_found" });
				}

				const activeTechnical = await this.dependencies.findActive("media-file-technical-refresh", mediaFileId);
				assertOperationCompatibility(activeTechnical ? [activeTechnical] : [], options.operationId, "technical media refresh");
				const technicalTask = activeTechnical ?? (await this.dependencies.scheduleTechnical(mediaFileId, options));

				// A metadata refresh already running (under any operation) is reused:
				// the caller's refresh still needs the technical part, but scheduling a
				// duplicate metadata refresh would conflict with the active operation.
				const activeMetadata = await this.dependencies.findActive("metadata-refresh", metadataId);
				const metadataTask =
					activeMetadata ??
					(await this.dependencies.scheduleMetadata(
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
