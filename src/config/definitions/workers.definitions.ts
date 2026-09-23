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
} as const;
