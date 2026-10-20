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
 *   bun run scripts/benchmark.script.ts query-count [--rows 5000]
 *
 * Add new cases here when an optimization lands; extend the shared seeder
 * (lib/seed.ts) instead of inlining seed SQL.
 */

import { main, printTable, suiteArgs, task } from "benchkit";
import type { SidecarArtworkWriter } from "@/modules/metadata-sidecars/saver/sidecar-artwork.exporter";
import type { SidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar.types";
import { seedCatalog } from "./lib/seed.utils";

// Statement counting is enabled right after the factory import: late enabling
// counts statements without the timing proxy, and the runner evaluates
// env.config before suites load, so an env flag set here could no longer reach
// the logger (tests construct their own factory with `queryStats: true`).
const { databaseFactory } = await import("@/integrations/drizzle-orm/database.factory");
databaseFactory.enableQueryStats();
const { librariesRepository } = await import("@/app/repositories/libraries.repository");
const { collectionRepository } = await import("@/app/repositories/collections.repository");
const { genreRepository } = await import("@/app/repositories/genres.repository");
const { mediaRepository } = await import("@/app/repositories/media-files.repository");
const { metadataRepository } = await import("@/app/repositories/metadata.repository");
const { playbackRepository } = await import("@/app/repositories/playback.repository");
const { watchedHistoryRepository } = await import("@/app/repositories/watched-history.repository");
const { workerOperationRepository } = await import("@/app/repositories/worker-operation.repository");
const { sessionsRepository } = await import("@/app/repositories/sessions.repository");
const { adminAuditRepository } = await import("@/app/repositories/admin-audit.repository");
const { playbackViewService } = await import("@/app/media/playback-view.service");
const { SidecarMetadataStorageService } = await import("@/modules/metadata-sidecars/sidecar-metadata-storage.service");
const { playbackProgressService } = await import("@/app/playback/playback-progress.service");
const { librariesService } = await import("@/app/libraries/libraries.service");
const { loadRelations } = await import("@/app/repositories/metadata-relations.repository");
const { wireModulePorts } = await import("@/app/wiring/module-ports");

// The sidecar case drives SidecarMetadataStorageService, which reads through
// module ports wired by the composition root at boot; wire the same
// implementations here so the counted statements match the server.
wireModulePorts();

export const meta = { description: "Statement-count audit (queries per operation, targets gate --strict)" };

const PROFILE_ID = "profile-1";
const MOVIE_ID = "meta-0000001";
const LIBRARY_ID = "lib-bench";
const BATCH_SIZE = 50;
const BATCH_IDS = Array.from({ length: BATCH_SIZE }, (_, i) => `meta-${String(i).padStart(7, "0")}`);
/** A full 5000-title collection: the list relation reader runs 3 statements per `queryChunkSize` chunk. */
const LARGE_IDS = Array.from({ length: 5000 }, (_, i) => `meta-${String(i).padStart(7, "0")}`);

interface OperationCase {
	name: string;
	/** Post-optimization statement budget; null = audit only, no gate. */
	target: number | null;
	/** Runs before the counter reset (e.g. to warm a cache) — not measured. */
	warmup?: (() => Promise<unknown>) | undefined;
	run: () => Promise<unknown>;
}

interface OperationResult {
	name: string;
	statements: number;
	target: number | null;
	ms: number;
	ok: boolean;
}

function createSidecarFixture() {
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

	return { sidecarFiles, sidecarStorage };
}

type SidecarFixture = ReturnType<typeof createSidecarFixture>;

function repositoryOperationCases(): OperationCase[] {
	return [
		{
			name: "metadataRepository.findPage (24, full)",
			target: 5,
			run: () => metadataRepository.findPage({ limit: 24 }),
		},
		{
			// Root row and all ten relations ride one prepared statement.
			name: "metadataRepository.findById (movie detail)",
			target: 1,
			run: () => metadataRepository.findById({ primaryId: MOVIE_ID }),
		},
		{
			name: "librariesRepository.findByIdForRead (fields=id,type)",
			target: 1,
			run: () => librariesRepository.findByIdForRead(LIBRARY_ID, { fields: "id,type" }),
		},
		{
			// The named-entity detail read goes through the table-access by-id
			// reader, which serves the default projection from a prepared statement.
			name: "genreRepository.findByIdForRead (default projection)",
			target: 1,
			run: () => genreRepository.findByIdForRead("genre-0"),
		},
		{
			// The findings statement carries the library-existence flag in its
			// counts row, so the not-found check needs no round trip.
			name: "librariesService.getScanFindings (findings + existence flag)",
			target: 1,
			run: () => librariesService.getScanFindings(LIBRARY_ID),
		},
		{
			name: "collectionRepository.findPage (24, cold count)",
			target: 4,
			run: () => collectionRepository.findPage({ limit: 24 }),
		},
		{
			name: "collectionRepository.findPage (24, warm count cache)",
			target: 2,
			warmup: () => collectionRepository.findPage({ limit: 24 }),
			run: () => collectionRepository.findPage({ limit: 24 }),
		},
		{
			name: "workerOperationRepository.list (24, cold count)",
			target: 2,
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
			target: 2,
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
			target: 2,
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
			target: 6,
			run: () => mediaRepository.findPage({ limit: 24 }),
		},
		{
			// Single-row ids ride one JSON bundle statement (row + four relations)
			// instead of the row plus four batched relation reads.
			name: "mediaRepository.findByIdForRead (single row)",
			target: 1,
			run: () => mediaRepository.findByIdForRead("mf-episode-0-0-0"),
		},
		{
			// Session start: the file, its relation bundle, the viewer's saved
			// position, the title-level resume check and the per-title stream
			// preferences ride one statement (the profile preferences read is
			// cached and separate).
			name: "mediaRepository.findPlaybackSessionData (session start)",
			target: 1,
			run: () => mediaRepository.findPlaybackSessionData("mf-meta-0000000", PROFILE_ID, 120),
		},
		{
			// Discover's two "recently added" lists share one row read and one
			// relation load; each type keeps its own ranking statement.
			name: "metadataRepository.findRecentlyAddedByTypes (movie+tv, 50)",
			target: 6,
			run: () => metadataRepository.findRecentlyAddedByTypes(["movie", "tv_show"], 50),
		},
		{
			// The batched list reader binds the id list as one JSON parameter, so
			// the whole 5,000-id list runs as 3 prepared statements.
			name: "loadRelations (5000 ids, batched list reader)",
			target: 3,
			run: () => loadRelations(LARGE_IDS),
		},
	];
}

function playbackOperationCases(sidecar: SidecarFixture): OperationCase[] {
	return [
		{
			name: "watchedHistoryRepository.findPage (50)",
			target: 3,
			run: () => watchedHistoryRepository.findPage(PROFILE_ID, { limit: 50 }),
		},
		{
			// The statement also carries the title row (type + numbering mode),
			// so the row lookup costs no extra round trip.
			name: "playbackRepository.findSmartPlayData (single id)",
			target: 1,
			run: () => playbackRepository.findSmartPlayData(MOVIE_ID, PROFILE_ID),
		},
		{
			// The batch statement carries the media files, the profile's progress,
			// the title rows, the seasons/episodes arrays for series ids and the
			// watchlist flags, so a movie batch is one statement.
			name: `playbackProgressService.getSmartPlayBatch (${BATCH_SIZE} ids)`,
			target: 1,
			run: () => playbackProgressService.getSmartPlayBatch(BATCH_IDS, PROFILE_ID),
		},
		{
			// A batch containing a series used to run separate seasons/episodes and
			// metadata statements; both now ride the batch statement.
			name: "playbackProgressService.getSmartPlayBatch (series batch)",
			target: 1,
			run: () => playbackProgressService.getSmartPlayBatch(["show-0"], PROFILE_ID),
		},
		{
			// The dependent reads — titles, files, regular seasons/episodes and
			// backdrops — ride one statement over the same id list, so the page
			// read and it remain.
			name: "playbackRepository.findContinueWatchingData (12)",
			target: 2,
			run: () => playbackRepository.findContinueWatchingData(PROFILE_ID, 12),
		},
		{
			// The context bundle reads the file, its relations, its markers, the
			// root metadata row and the episode with its files in one statement;
			// the overview carries its media+progress, seasons+episodes and the
			// next-episode resolution in one; the preferences read remains — so
			// 3 statements.
			name: "playbackViewService.getPlaybackView (episode → next)",
			target: 3,
			run: () => playbackViewService.getPlaybackView("mf-episode-0-0-0", PROFILE_ID),
		},
		{
			name: "sidecarMetadataStorage.saveLibraryMedia (20 episode files)",
			target: 6,
			run: () =>
				sidecar.sidecarStorage.saveLibraryMedia(
					{ metadataStorageMode: "sidecar", paths: [{ path: "/media", metadataStorageMode: null }] },
					sidecar.sidecarFiles,
				),
		},
	];
}

async function measureOperation(operationCase: OperationCase): Promise<OperationResult> {
	if (operationCase.warmup) await operationCase.warmup();

	databaseFactory.resetQueryStats();
	const start = performance.now();
	await operationCase.run();
	const ms = performance.now() - start;
	const { queryCount } = databaseFactory.getQueryStats();
	const ok = operationCase.target === null || queryCount <= operationCase.target;

	return { name: operationCase.name, statements: queryCount, target: operationCase.target, ms, ok };
}

function printOperationTable(results: OperationResult[]): void {
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
}

/** Prints the over-budget operations and returns them. */
function reportBudget(results: OperationResult[]): OperationResult[] {
	const failing = results.filter((result) => !result.ok);
	if (failing.length > 0) {
		console.log(`\n[query-count] ${failing.length}/${results.length} operations over budget:`);
		for (const result of failing) console.log(`  - ${result.name}: ${String(result.statements)} > ${String(result.target)}`);
	} else {
		console.log(`\n[query-count] all ${results.length} operations within budget.`);
	}

	return failing;
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

		const sidecar = createSidecarFixture();
		const cases = [...repositoryOperationCases(), ...playbackOperationCases(sidecar)];

		const results: OperationResult[] = [];
		for (const operationCase of cases) {
			results.push(await measureOperation(operationCase));
		}

		printOperationTable(results);
		const failing = reportBudget(results);

		return {
			ok: failing.length === 0,
			data: { operations: results.length, overBudget: failing.length, rows: args.rows },
		};
	});
}

await main(import.meta);
