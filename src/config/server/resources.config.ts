import { serverConstants } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { systemSettingsStore } from "@/config/system-settings.store";
import { clamp } from "@/utils/math.utils";

/** CPU, memory and rescue settings, plus the settings that scale with installed RAM and measured capacity. */
export const resourceConfig = {
	/** Smart CPU & Resource Allocation Engine */
	resources: {
		get monitoringEnabled() {
			return systemSettingsStore.get("system.resources.monitoringEnabled");
		},
		get monitoringIntervalMs() {
			return systemSettingsStore.get("system.resources.monitoringIntervalMs");
		},

		get memoryThresholdPercent() {
			return systemSettingsStore.get("system.resources.memoryThresholdPercent");
		},
		get memoryCriticalPercent() {
			return systemSettingsStore.get("system.resources.memoryCriticalPercent");
		},

		get diskThresholdPercent() {
			return systemSettingsStore.get("system.resources.diskThresholdPercent");
		},

		get enableDynamicThrottling() {
			return systemSettingsStore.get("system.resources.enableDynamicThrottling");
		},
		get throttleLowPriorityAbovePercent() {
			return systemSettingsStore.get("system.resources.throttleLowPriorityAbovePercent");
		},

		get streamingGuaranteedCores() {
			return systemSettingsStore.get("system.resources.streamingGuaranteedCores");
		},
	},

	/** Server Rescue — emergency throttle of all background work when the server is drowning */
	rescue: {
		get enabled() {
			return systemSettingsStore.get("system.rescue.enabled");
		},
		get eventLoopLagMs() {
			return systemSettingsStore.get("system.rescue.eventLoopLagMs");
		},
		get sustainMs() {
			return systemSettingsStore.get("system.rescue.sustainMs");
		},
		get releaseMs() {
			return systemSettingsStore.get("system.rescue.releaseMs");
		},
	},

	// In-flight responses are held serialized in RAM — the cap scales with
	// installed memory so a 4 GB box can't OOM on a catalog stampede.
	requestDedup: {
		...serverConstants.requestDedup,
		get maxConcurrent() {
			return systemResourcesService.getMaxInflightResponses();
		},
		// Followers wait for a leader whose latency is CPU-bound.
		get waitTimeoutMs() {
			return systemResourcesService.scaledTimeoutMs(serverConstants.requestDedup.waitTimeoutMs);
		},
	},

	// A 40 MP RGBA decode pipeline holds ~160 MB × sharpConcurrency —
	// scale the decode ceiling with installed RAM (12 MP floor on tiny boxes).
	sharp: {
		...serverConstants.sharp,
		get maxInputPixels() {
			return clamp(Math.floor(((systemResourcesService.getTotalMemoryKiB() ?? 8_388_608) / 1024) * 6.4), 12_000_000, 40_000_000);
		},
	},

	application: {
		...serverConstants.application,
		// Delete/stat sweeps are pure fs I/O — scale with measured capacity so
		// slow storage never queues 8+ parallel unlinks.
		get cleanupConcurrency() {
			return systemResourcesService.getIoConcurrency();
		},
	},
};
