/** Canonical (kebab-case) worker ids used across scheduling, allocation and settings. */
export type CanonicalWorkerId =
	| "image-processing"
	| "media-file-technical-refresh"
	| "metadata-refresh"
	| "media-file-analysis"
	| "scanning"
	| "transcode";

/** Every accepted spelling (camelCase, kebab-case, legacy aliases) mapped to its canonical id. */
const WORKER_ID_ALIASES: Record<string, CanonicalWorkerId> = {
	imageProcessing: "image-processing",
	"image-processing": "image-processing",
	imageOptimization: "image-processing",
	"image-optimization": "image-processing",
	imageOptimizationAll: "image-processing",
	"image-optimization-all": "image-processing",
	metadataRefresh: "metadata-refresh",
	"metadata-refresh": "metadata-refresh",
	mediaFileTechnicalRefresh: "media-file-technical-refresh",
	"media-file-technical-refresh": "media-file-technical-refresh",
	mediaFileAnalysis: "media-file-analysis",
	"media-file-analysis": "media-file-analysis",
	scanning: "scanning",
	transcode: "transcode",
};

/** Canonical kebab-case worker id for any accepted spelling; undefined for unknown ids. */
export function canonicalWorkerId(workerId: string): CanonicalWorkerId | undefined {
	return WORKER_ID_ALIASES[workerId];
}
