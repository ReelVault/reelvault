import { HOUR, MINUTE, serverConstants } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";

export interface BackoffConfig {
	readonly type: "fixed" | "exponential";
	readonly delayMs: number;
}

const WORKER_BACKOFF_2S: BackoffConfig = { type: "exponential", delayMs: 2_000 } as const;

/** Worker task queues, schedulers and per-definition concurrency, timeouts and retries. */
export const workerConfig = {
	/** Worker Task Queues & Schedulers */
	workers: {
		scheduling: {
			...serverConstants.workers.scheduling,
			get pollIntervalMs() {
				return systemSettingsStore.get("workers.scheduling.pollIntervalMs");
			},
		},
		definitions: {
			...serverConstants.workers.fixedDefinitions,
			libraryScan: {
				...serverConstants.workers.fixedDefinitions.libraryScan,
				get timeoutMs() {
					return systemSettingsStore.get("workers.definitions.libraryScan.timeoutMs");
				},
			},
			imageProcessing: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.imageProcessing.concurrency");
				},
				timeoutMs: 5 * MINUTE,
				removeOnComplete: 100,
				removeOnFail: 100,
				priorities: { metadata: 1, season: 2, episode: 3, person: 4 },
			},
			mediaFileAnalysis: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.mediaFileAnalysis.concurrency");
				},
				timeoutMs: 10 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			mediaFileTechnicalRefresh: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.mediaFileTechnicalRefresh.concurrency");
				},
				timeoutMs: 10 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			metadataRefresh: {
				get concurrency() {
					return systemSettingsStore.get("workers.definitions.metadataRefresh.concurrency");
				},
				timeoutMs: HOUR,
				removeOnComplete: 10,
				removeOnFail: 50,
			},
			// Overrides the spread above: each stream-init task spawns an FFmpeg
			// process, so concurrency derives from measured CPU capacity — a weak
			// 12-thread box gets 1-2 parallel stream starts, a fast one gets 2.
			streamInitialization: {
				get concurrency() {
					return systemResourcesService.getHeavySubprocessConcurrency();
				},
				timeoutMs: 2 * MINUTE,
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			// One file at a time — the generator itself fans out per-sprite ffmpeg
			// processes sized from measured CPU capacity.
			trickplayGenerate: {
				concurrency: 1,
				timeoutMs: 30 * MINUTE,
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			downloadsProcess: {
				concurrency: 1,
				get timeoutMs() {
					return systemSettingsStore.get("workers.definitions.downloadsProcess.timeoutMs");
				},
				attempts: 1,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
			// Overrides the spread: ingest runs an ffprobe plus catalog writes per
			// file — derive from measured CPU capacity, not a fixed number.
			mediaFileIngest: {
				get concurrency() {
					return systemResourcesService.getIngestConcurrency();
				},
				timeoutMs: 30 * MINUTE,
				attempts: 3,
				backoff: WORKER_BACKOFF_2S,
				removeOnComplete: 100,
				removeOnFail: 100,
			},
		},
	},
};
