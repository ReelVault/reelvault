import { SystemSettingsCreator } from "../system-settings.utils";

const creator = SystemSettingsCreator("workers");

export const WORKERS_SETTINGS_DEFINITIONS = {
	"workers.scheduling.pollIntervalMs": creator.number("workers.scheduling.pollIntervalMs", 100, 60_000, 1000),
	"workers.definitions.imageProcessing.concurrency": creator.number("workers.definitions.imageProcessing.concurrency", 0, 16, 0),
	"workers.definitions.mediaFileAnalysis.concurrency": creator.number("workers.definitions.mediaFileAnalysis.concurrency", 0, 16, 0),
	"workers.definitions.mediaFileTechnicalRefresh.concurrency": creator.number(
		"workers.definitions.mediaFileTechnicalRefresh.concurrency",
		0,
		16,
		0,
	),
	"workers.definitions.metadataRefresh.concurrency": creator.number("workers.definitions.metadataRefresh.concurrency", 0, 16, 0),
	// Stall timeouts in milliseconds: one minute to one day, defaults match the former constants (2 h).
	"workers.definitions.libraryScan.timeoutMs": creator.number("workers.definitions.libraryScan.timeoutMs", 60_000, 86_400_000, 7_200_000),
	"workers.definitions.downloadsProcess.timeoutMs": creator.number(
		"workers.definitions.downloadsProcess.timeoutMs",
		60_000,
		86_400_000,
		7_200_000,
	),
} as const;
