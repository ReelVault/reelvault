import { SystemSettingsCreator } from "@/config/system-settings.utils";

const creator = SystemSettingsCreator("workers");

/** Stall timeouts in milliseconds: one minute to one day, default two hours (the former constant). */
function stallTimeoutMs(key: string) {
	return creator.number(key, 60_000, 86_400_000, 7_200_000, { unit: "ms" });
}

export const WORKERS_SETTINGS_DEFINITIONS = {
	"workers.scheduling.pollIntervalMs": creator.number("workers.scheduling.pollIntervalMs", 100, 60_000, 1000, { unit: "ms" }),
	"workers.definitions.imageProcessing.concurrency": creator.number("workers.definitions.imageProcessing.concurrency", 0, 16, 0),
	"workers.definitions.mediaFileAnalysis.concurrency": creator.number("workers.definitions.mediaFileAnalysis.concurrency", 0, 16, 0),
	"workers.definitions.mediaFileTechnicalRefresh.concurrency": creator.number(
		"workers.definitions.mediaFileTechnicalRefresh.concurrency",
		0,
		16,
		0,
	),
	"workers.definitions.metadataRefresh.concurrency": creator.number("workers.definitions.metadataRefresh.concurrency", 0, 16, 0),
	"workers.definitions.libraryScan.timeoutMs": stallTimeoutMs("workers.definitions.libraryScan.timeoutMs"),
	"workers.definitions.downloadsProcess.timeoutMs": stallTimeoutMs("workers.definitions.downloadsProcess.timeoutMs"),
} as const;
