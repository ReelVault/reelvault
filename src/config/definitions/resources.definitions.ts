import type { CpuProfile } from "../system-settings.types";
import { SystemSettingsCreator } from "../system-settings.utils";

const CPU_PROFILE_OPTIONS: readonly CpuProfile[] = ["conservative", "balanced", "performance", "custom"];

const creator = SystemSettingsCreator("resources");

export const RESOURCES_SETTINGS_DEFINITIONS = {
	"system.resources.cpuProfile": creator.enum("system.resources.cpuProfile", [...CPU_PROFILE_OPTIONS], "balanced"),

	"system.resources.maxCpuCores": creator.number("system.resources.maxCpuCores", 0, 256, 0),
	"system.resources.reservedCoresForWeb": creator.number("system.resources.reservedCoresForWeb", 0, 64, 0),
	"system.resources.ffmpegMaxThreads": creator.number("system.resources.ffmpegMaxThreads", 0, 32, 0),
	"system.resources.workerPoolMaxConcurrent": creator.number("system.resources.workerPoolMaxConcurrent", 0, 64, 0),

	"system.resources.monitoringEnabled": creator.boolean("system.resources.monitoringEnabled", true),
	"system.resources.monitoringIntervalMs": creator.number("system.resources.monitoringIntervalMs", 1000, 60_000, 5000),

	"system.resources.memoryThresholdPercent": creator.number("system.resources.memoryThresholdPercent", 50, 99, 85),
	"system.resources.memoryCriticalPercent": creator.number("system.resources.memoryCriticalPercent", 80, 99, 95),

	"system.resources.diskThresholdPercent": creator.number("system.resources.diskThresholdPercent", 50, 99, 90),

	"system.resources.enableDynamicThrottling": creator.boolean("system.resources.enableDynamicThrottling", true),
	"system.resources.throttleLowPriorityAbovePercent": creator.number("system.resources.throttleLowPriorityAbovePercent", 50, 95, 80),

	"system.resources.streamingGuaranteedCores": creator.number("system.resources.streamingGuaranteedCores", 0, 16, 1),

	// Last-resort protection: when the event loop or machine is drowning, pause all
	// non-streaming background work (worker claims + plugin ffmpeg) until healthy again.
	"system.rescue.enabled": creator.boolean("system.rescue.enabled", true),

	// Max event-loop lag (timer drift) tolerated before a breach is recorded.
	"system.rescue.eventLoopLagMs": creator.number("system.rescue.eventLoopLagMs", 50, 5000, 250),

	// Breach must persist this long before rescue kicks in (avoid reacting to spikes).
	"system.rescue.sustainMs": creator.number("system.rescue.sustainMs", 0, 300_000, 15_000),

	// Machine must stay healthy this long before rescue releases and background work resumes.
	"system.rescue.releaseMs": creator.number("system.rescue.releaseMs", 5000, 600_000, 60_000),
} as const;
