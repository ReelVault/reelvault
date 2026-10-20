import { getHeapStatistics } from "node:v8";
import type { AdminCacheStats, AdminStats } from "@reelvault/sdk/common";
import { adminStatsRepository } from "@/app/repositories/admin-stats.repository";
import { serverConfig } from "@/config/server/server.config";
import { sessionLifecycleService } from "@/modules/streaming/sessions/session-lifecycle.service";
import { resourceAllocator } from "@/system/resource-allocator.service";
import { measureDirectory } from "@/system/server-data.utils";
import { workerService } from "@/workers/worker.service";

function sumWorkerCounters(queues: Array<{ active: number; waiting: number; completed: number; failed: number }>) {
	const total = { active: 0, waiting: 0, completed: 0, failed: 0 };
	for (const queue of queues) {
		total.active += queue.active;
		total.waiting += queue.waiting;
		total.completed += queue.completed;
		total.failed += queue.failed;
	}

	return total;
}

/** Dashboard counters. Full-table aggregates, so the caller caches the result. */
export async function computeStats(): Promise<AdminStats> {
	const activeSessions = sessionLifecycleService.getActiveSessions();
	const [workerQueues, mediaRow, metadataRow, markersRow] = await Promise.all([
		workerService.getStats().catch(() => []),
		adminStatsRepository.getMediaStats(),
		adminStatsRepository.getMetadataStats(),
		adminStatsRepository.getMarkerStats(),
	]);

	const systemSnapshot = resourceAllocator.getCurrentSnapshot();

	return {
		uptime: process.uptime(),
		memory: { ...process.memoryUsage(), heapLimit: getHeapStatistics().heap_size_limit },
		...(systemSnapshot
			? {
					systemMemory: {
						usedMb: systemSnapshot.memory.usedMb,
						totalMb: systemSnapshot.memory.totalMb,
						percent: systemSnapshot.memory.percent,
					},
					pressure: systemSnapshot.pressure,
				}
			: {}),
		streaming: { activeSessions },
		timestamp: new Date().toISOString(),
		workers: sumWorkerCounters(workerQueues),
		media: {
			totalFiles: mediaRow.totalFiles ?? 0,
			totalSize: mediaRow.totalSize ?? 0,
			moviesCount: mediaRow.moviesCount ?? 0,
			episodesCount: mediaRow.episodesCount ?? 0,
			withQualityCount: mediaRow.withQualityCount ?? 0,
		},
		metadata: {
			totalCount: metadataRow.totalCount ?? 0,
			moviesCount: metadataRow.moviesCount ?? 0,
			tvShowsCount: metadataRow.tvShowsCount ?? 0,
			lowConfidenceCount: metadataRow.lowConfidenceCount ?? 0,
			missingTranslationCount: metadataRow.missingTranslationCount ?? 0,
		},
		markers: {
			totalCount: markersRow.totalCount ?? 0,
			introsCount: markersRow.introsCount ?? 0,
			creditsCount: markersRow.creditsCount ?? 0,
			highlightsCount: markersRow.highlightsCount ?? 0,
			fromPluginsCount: markersRow.fromPluginsCount ?? 0,
		},
	};
}

/** Size on disk of the three regenerable caches. */
export async function measureDiskCaches(): Promise<AdminCacheStats["disk"]> {
	const [transcodes, images, subtitles] = await Promise.all([
		measureDirectory(serverConfig.paths.transcodes),
		measureDirectory(serverConfig.paths.images),
		measureDirectory(serverConfig.paths.subtitles),
	]);

	return { transcodes, images, subtitles };
}
