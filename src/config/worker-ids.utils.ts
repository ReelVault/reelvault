/** The definition id of the library-scan worker, shared by the enqueue helpers and the worker itself. */
export const LIBRARY_SCAN_WORKER_ID = "library-scan";

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

/** Categories that receive an automatic CPU concurrency budget; the rest get 1. */
export type BudgetedWorkerId = "image-processing" | "metadata-refresh" | "media-file-technical-refresh" | "media-file-analysis";

/** Every accepted spelling (definition id, camelCase settings key, virtual
 * allocation category) mapped to its category. Definition ids that have no
 * resource category must be listed in UNCATEGORIZED_WORKER_IDS instead —
 * built-in-workers.test.ts enforces that the union covers every registered worker. */
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
	[LIBRARY_SCAN_WORKER_ID]: "scanning",
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
	"clean-up-orphan-subtitles",
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

/**
 * Workers that keep running during server rescue because they serve active
 * playback sessions. Everything else is expendable and can resume later.
 */
export const PROTECTED_WORKER_IDS: ReadonlySet<string> = new Set(["stream-init", "transcode"]);

/**
 * Workers whose restart requeue is capped. A trickplay job on a hung dataset
 * otherwise survives every update/restart, starts again, hangs the host, and
 * repeats — one file held a server down through nine restarts in the incident
 * this guard comes from.
 */
export const RESTART_CAPPED_WORKER_IDS: ReadonlySet<string> = new Set(["trickplay-generate"]);

/** Resource category for any accepted spelling; undefined for uncategorized workers. */
export function canonicalWorkerId(workerId: string): CanonicalWorkerId | undefined {
	return WORKER_ID_ALIASES[workerId];
}
