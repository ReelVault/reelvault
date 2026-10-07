/**
 * Statement-count audit.
 *
 * Measures how many SQL statements each hot operation executes on an isolated,
 * migrated and seeded database. The point is not timing (the query logger
 * instruments statements with a Proxy, which distorts micro-timings) but the
 * query count: SQLite is synchronous on one connection, so statement count is
 * the latency currency. Each case carries the target the optimization work must
 * reach; `--strict` fails the run while any target is exceeded.
 *
 * Usage:
 *   bun run scripts/benchmark.ts query-count [--rows 5000]
 *
 * Add new cases here when an optimization lands; extend the shared seeder
 * (lib/seed.ts) instead of inlining seed SQL.
 */

import { main, printTable, suiteArgs, task } from "benchkit";
import type { SidecarArtworkWriter } from "@/modules/metadata-sidecars/saver/sidecar-artwork.exporter";
import type { SidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar.types";
import { seedCatalog } from "./lib/seed";

// Statement counting must be enabled before the ambient factory is constructed,
// and static imports are hoisted — so the database module is imported dynamically.
// The repositories resolve `databaseFactory` from this same module instance.
process.env.APP_SLOW_QUERY_LOG = "true";
const { databaseFactory } = await import("@/database/database");
const { librariesRepository } = await import("@/database/repositories/libraries.repository");
const { collectionRepository } = await import("@/database/repositories/collections.repository");
const { mediaRepository } = await import("@/database/repositories/media-files.repository");
const { metadataRepository } = await import("@/database/repositories/metadata.repository");
const { playbackRepository } = await import("@/database/repositories/playback.repository");
const { watchedHistoryRepository } = await import("@/database/repositories/watched-history.repository");
const { workerOperationRepository } = await import("@/database/repositories/worker-operation.repository");
const { sessionsRepository } = await import("@/database/repositories/sessions.repository");
const { adminAuditRepository } = await import("@/database/repositories/admin-audit.repository");
const { playbackViewService } = await import("@/application/media/playback-view.service");
const { SidecarMetadataStorageService } = await import("@/modules/metadata-sidecars/sidecar-metadata-storage.service");
const { playbackProgressService } = await import("@/modules/streaming/progress/playback-progress.service");
const { librariesService } = await import("@/application/libraries/libraries.service");

export const meta = { description: "Statement-count audit (queries per operation, targets gate --strict)" };

const PROFILE_ID = "profile-1";
const MOVIE_ID = "meta-0000001";
const LIBRARY_ID = "lib-bench";
const BATCH_SIZE = 50;
const BATCH_IDS = Array.from({ length: BATCH_SIZE }, (_, i) => `meta-${String(i).padStart(7, "0")}`);

interface OperationCase {
	name: string;
	/** Post-optimization statement budget; null = audit only, no gate. */
	target: number | null;
	/** Runs before the counter reset (e.g. to warm a cache) — not measured. */
	warmup?: (() => Promise<unknown>) | undefined;
	run: () => Promise<unknown>;
}

const args = suiteArgs();

if (!args.help) {
	task("query-count: statement counts per operation", async () => {
		console.log(`[query-count] migrating and seeding ${args.rows} rows...`);
		databaseFactory.migrate();
		seedCatalog(databaseFactory.sqlite, {
			rows: args.rows,
			repositoryExtras: true,
			history: { profileId: PROFILE_ID, everyNth: 3, duration: 3000 },
			progress: true,
			series: { shows: 1, seasons: 2, episodesPerSeason: 10 },
			analyze: true,
		});

		const sidecarFiles = Array.from({ length: 20 }, (_, index) => ({
			filePath: `/media/show/Season 0${Math.floor(index / 10) + 1}/episode-${index}.mkv`,
			metadataId: "show-0",
			movieId: null,
			episodeId: `episode-0-${Math.floor(index / 10)}-${index % 10}`,
		}));
		const sidecarStorage = new SidecarMetadataStorageService(
			{
				saveMovie: () => Promise.resolve({ documentPath: "", writtenFiles: [] }),
				saveSeries: () => Promise.resolve({ documentPath: "", writtenFiles: [] }),
				saveSeason: () => Promise.resolve({ documentPath: "", writtenFiles: [] }),
				saveEpisode: () => Promise.resolve({ documentPath: "", writtenFiles: [] }),
			} satisfies SidecarMetadataWriter,
			{
				saveTitleArtwork: () => Promise.resolve([]),
				saveSeasonArtwork: () => Promise.resolve([]),
				saveEpisodeArtwork: () => Promise.resolve([]),
			} satisfies SidecarArtworkWriter,
		);

		const cases: OperationCase[] = [
			{
				name: "metadataRepository.findPage (24, full)",
				target: null,
				run: () => metadataRepository.findPage({ limit: 24 }),
			},
			{
				name: "metadataRepository.findById (movie detail)",
				target: null,
				run: () => metadataRepository.findById({ primaryId: MOVIE_ID }),
			},
			{
				name: "librariesRepository.findByIdForRead (fields=id,type)",
				target: 1,
				run: () => librariesRepository.findByIdForRead(LIBRARY_ID, { fields: "id,type" }),
			},
			{
				// Internal scan paths read the library without the provider-priority
				// overrides getById loads; findings add one query.
				name: "librariesService.getScanFindings (existence + findings)",
				target: 2,
				run: () => librariesService.getScanFindings(LIBRARY_ID),
			},
			{
				name: "collectionRepository.findPage (24, cold count)",
				target: null,
				run: () => collectionRepository.findPage({ limit: 24 }),
			},
			{
				name: "collectionRepository.findPage (24, warm count cache)",
				target: 5,
				warmup: () => collectionRepository.findPage({ limit: 24 }),
				run: () => collectionRepository.findPage({ limit: 24 }),
			},
			{
				name: "workerOperationRepository.list (24, cold count)",
				target: null,
				run: () => workerOperationRepository.list({ limit: 24 }),
			},
			{
				name: "workerOperationRepository.list (24, warm count cache)",
				target: 1,
				warmup: () => workerOperationRepository.list({ limit: 24 }),
				run: () => workerOperationRepository.list({ limit: 24 }),
			},
			{
				name: "sessionsRepository.findActivePageByUserId (cold count)",
				target: null,
				run: () => sessionsRepository.findActivePageByUserId(PROFILE_ID, { limit: 24 }),
			},
			{
				name: "sessionsRepository.findActivePageByUserId (warm count cache)",
				target: 1,
				warmup: () => sessionsRepository.findActivePageByUserId(PROFILE_ID, { limit: 24 }),
				run: () => sessionsRepository.findActivePageByUserId(PROFILE_ID, { limit: 24 }),
			},
			{
				name: "adminAuditRepository.findMany (cold count)",
				target: null,
				run: () => adminAuditRepository.findMany({ page: 1, limit: 20 }),
			},
			{
				name: "adminAuditRepository.findMany (warm count cache)",
				target: 1,
				warmup: () => adminAuditRepository.findMany({ page: 1, limit: 20 }),
				run: () => adminAuditRepository.findMany({ page: 1, limit: 20 }),
			},
			{
				name: "mediaRepository.findPage (24)",
				target: null,
				run: () => mediaRepository.findPage({ limit: 24 }),
			},
			{
				name: "watchedHistoryRepository.findPage (50)",
				target: null,
				run: () => watchedHistoryRepository.findPage(PROFILE_ID, { limit: 50 }),
			},
			{
				name: "playbackRepository.findSmartPlayData (single id)",
				target: null,
				run: () => playbackRepository.findSmartPlayData(MOVIE_ID, PROFILE_ID),
			},
			{
				name: `playbackProgressService.getSmartPlayBatch (${BATCH_SIZE} ids)`,
				target: 8,
				run: () => playbackProgressService.getSmartPlayBatch(BATCH_IDS, PROFILE_ID),
			},
			{
				name: "playbackRepository.findContinueWatchingData (12)",
				target: null,
				run: () => playbackRepository.findContinueWatchingData(PROFILE_ID, 12),
			},
			{
				name: "playbackViewService.getPlaybackView (episode → next)",
				target: 16,
				run: () => playbackViewService.getPlaybackView("mf-episode-0-0-0", PROFILE_ID),
			},
			{
				name: "sidecarMetadataStorage.saveLibraryMedia (20 episode files)",
				target: 6,
				run: () =>
					sidecarStorage.saveLibraryMedia(
						{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
						sidecarFiles,
					),
			},
		];

		const results: Array<{ name: string; statements: number; target: number | null; ms: number; ok: boolean }> = [];
		for (const operationCase of cases) {
			if (operationCase.warmup) await operationCase.warmup();

			databaseFactory.resetQueryStats();
			const start = performance.now();
			await operationCase.run();
			const ms = performance.now() - start;
			const { queryCount } = databaseFactory.getQueryStats();
			const ok = operationCase.target === null || queryCount <= operationCase.target;
			results.push({ name: operationCase.name, statements: queryCount, target: operationCase.target, ms, ok });
		}

		const tableRows = results.map((result) => {
			const target = result.target === null ? "-" : String(result.target);
			let status = "audit";
			if (result.target !== null) status = result.ok ? "ok" : "over";

			return [result.name, String(result.statements), target, result.ms.toFixed(2), status];
		});
		printTable(
			"Statements per operation (target = post-optimization budget)",
			["operation", "statements", "target", "ms", "status"],
			tableRows,
		);

		const failing = results.filter((result) => !result.ok);
		if (failing.length > 0) {
			console.log(`\n[query-count] ${failing.length}/${results.length} operations over budget:`);
			for (const result of failing) console.log(`  - ${result.name}: ${String(result.statements)} > ${String(result.target)}`);
		} else {
			console.log(`\n[query-count] all ${results.length} operations within budget.`);
		}

		return {
			ok: failing.length === 0,
			data: { operations: results.length, overBudget: failing.length, rows: args.rows },
		};
	});
}

await main(import.meta);
