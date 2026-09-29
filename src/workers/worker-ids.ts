/** Resource categories (kebab-case) shared by scheduling, allocation and settings.
 * Several worker definitions can belong to one category — e.g. the image
 * optimization variants share the image-processing concurrency budget. */
export type CanonicalWorkerId =
	| "image-processing"
	| "media-file-technical-refresh"
	| "metadata-refresh"
	| "media-file-analysis"
	| "scanning"
	| "transcode";

/** Every accepted spelling (definition id, camelCase settings key, virtual
 * allocation category) mapped to its category. Definition ids that have no
 * resource category must be listed in UNCATEGORIZED_WORKER_IDS instead —
 * a worker-ids test enforces that the union covers every registered worker. */
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
	"library-scan": "scanning",
	transcode: "transcode",
};

/** Definition ids deliberately outside every resource category: singletons,
 * cleanup sweeps and audits. They keep the allocator defaults (weight 50,
 * concurrency 1) — explicit here so a newly registered worker id cannot
 * silently fall into those defaults without a decision. */
export const UNCATEGORIZED_WORKER_IDS: ReadonlySet<string> = new Set([
	"database-backup",
	"check-updates",
	"clean-up-database",
	"clean-up-logs",
	"clean-up-orphan-images",
	"clean-up-orphan-media-files",
	"clean-up-plugin-blobs",
	"clean-up-resource-metrics",
	"clean-up-transcodes",
	"clean-up-worker-history",
	"downloads-process",
	"library-errors-check",
	"media-file-ingest",
	"media-files-refresh-all",
	"media-files-audit",
	"media-match-audit",
	"media-match-audit-all",
	"stream-init",
	"trickplay-generate",
]);

/** Resource category for any accepted spelling; undefined for uncategorized workers. */
export function canonicalWorkerId(workerId: string): CanonicalWorkerId | undefined {
	return WORKER_ID_ALIASES[workerId];
}
