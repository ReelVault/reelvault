/**
 * Ingest pipeline benchmark.
 *
 * Two per-file costs that dominate adding a library, without touching the real
 * filesystem or ffprobe:
 *   1. `ScannerService.scanPaths` — the in-memory diff/guard pass once files
 *      have been discovered (dependency-injected: discovery, DB pages, guard).
 *   2. `auditMediaFileRow` — the per-row recognition + fuzzy ranking the audit
 *      report runs over every media file.
 *
 * Usage: bun run scripts/benchmark.ts ingest [--rows 50000] [--iterations 20]
 */

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, benchmarkAsync, group, main, printMicroResults, suiteArgs, task } from "benchkit";
import { $ } from "bun";
import { auditMediaFileRow } from "@/application/media/media-files/media-file-audit";
import { databaseFactory } from "@/database/database";
import type { MediaFileAuditRow } from "@/database/repositories/media-files.repository";
import { ScannerService } from "@/modules/scanner/scanner.service";

export const meta = { description: "Ingest pipeline (scanner diff/guard over N files, per-row audit recognition+fuzzy rank)" };

const DB_PAGE_SIZE = 5_000;

function buildScanFixture(count: number) {
	const rows = Array.from({ length: count }, (_, index) => ({
		id: `mf-${String(index).padStart(8, "0")}`,
		filePath: `/media/library/movie-${index}.mkv`,
		size: 1_000_000 + index,
		sourceMtimeMs: 1_700_000_000_000 + index,
	}));
	const statsByPath = new Map(rows.map((row) => [row.filePath, { size: row.size, mtimeMs: row.sourceMtimeMs }]));

	return { rows, statsByPath };
}

function buildAuditRows(count: number): MediaFileAuditRow[] {
	return Array.from({ length: count }, (_, index) => {
		const year = 2000 + (index % 25);

		return {
			mediaFileId: `mf-${index}`,
			fileName: `Some.Movie.${index}.${year}.1080p.BluRay.x264.mkv`,
			filePath: `/media/movies/Some Movie ${index} (${year})/Some.Movie.${index}.${year}.1080p.BluRay.x264.mkv`,
			libraryId: "lib-1",
			libraryName: "Movies",
			libraryType: "movies",
			metadataId: `meta-${index}`,
			metadataTitle: `Some Movie ${index}`,
			metadataOriginalTitle: null,
			metadataReleaseDate: `${year}-05-15`,
			metadataMatchScore: 0.9,
			metadataType: "movie",
			episodeNumber: null,
			seasonNumber: null,
		};
	});
}

const args = suiteArgs();

if (!args.help) {
	// `scanPaths` refreshes planner statistics at the end, so the DB must exist.
	databaseFactory.migrate();

	const { rows, statsByPath } = buildScanFixture(args.rows);
	const filesOnDisk = rows.map((row) => row.filePath);

	const scanner = new ScannerService({
		findStatsPage: (_libraryId, cursor, limit) => {
			const start = cursor ? rows.findIndex((row) => row.id > cursor) : 0;
			if (start === -1) return Promise.resolve([]);

			return Promise.resolve(rows.slice(start, start + limit));
		},
		discover: () => Promise.resolve({ filesOnDisk, statsByPath }),
		guard: { assess: () => Promise.resolve({ removedFiles: [], storageUnavailable: false, massRemoval: false, skipRemovals: false }) },
		cleaner: { cleanup: () => Promise.resolve() },
	});

	console.log(`[ingest] scan diff over ${args.rows} files (no changes), audit over ${args.rows} rows...`);

	group("Results (lower is better)", () => {
		bench(
			`ScannerService.scanPaths (${args.rows} files, ${DB_PAGE_SIZE}-row pages)`,
			async () => await scanner.scanPaths("lib-1", "movie", ["/media/library"]),
			{ warmup: 1, iterations: Math.max(2, Math.min(args.iterations, 10)) },
		);

		const auditRows = buildAuditRows(Math.min(args.rows, 5_000));
		bench(
			"auditMediaFileRow (recognition + fuzzy rank)",
			() => {
				for (const row of auditRows) auditMediaFileRow(row);
			},
			{ warmup: 2, iterations: Math.max(2, Math.min(args.iterations, 20)) },
		);
	});

	/**
	 * Real ffprobe phase — the discovery above deliberately stubs ffprobe out;
	 * this phase measures the actual spawn+parse path (`videoParser.probe`, the
	 * semaphore-bounded entry the scanner uses) over real copies of a generated
	 * fixture clip.
	 */
	task("ingest: real ffprobe spawn+parse", async () => {
		const { videoParser } = await import("@/modules/scanner/probe/video-parser.service");
		const { clearFFProbeCache } = await import("@/integrations/ffprobe/ffprobe.builder");

		const root = await mkdtemp(join(tmpdir(), "reelvault-benchmark-ffprobe-"));
		try {
			const fixturePath = join(root, "fixture.mp4");
			await $`ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=320x180:rate=12 -f lavfi -i sine=frequency=1000:sample_rate=44100 -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac ${fixturePath}`;

			const copies = 24;
			const paths: string[] = [];
			for (let index = 0; index < copies; index++) {
				const copyPath = join(root, `copy-${index}.mp4`);
				await copyFile(fixturePath, copyPath);
				paths.push(copyPath);
			}

			const iterations = Math.max(2, Math.min(args.iterations, 30));
			const probeResults = [
				await benchmarkAsync(
					`videoParser.probe (real ffprobe spawn+parse, ${copies}-file rotation)`,
					async (iteration) => {
						// The builder memoizes per path+stat — rotate and clear so every
						// iteration pays a real process spawn.
						clearFFProbeCache();
						const target = paths[Math.abs(iteration) % paths.length];
						if (!target) throw new Error("no probe target");

						const result = await videoParser.probe(target);
						if (!result) throw new Error("probe failed");
					},
					{ warmup: 2, iterations },
				),
			];

			printMicroResults(probeResults, "Real ffprobe (per probe call)");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

await main(import.meta);
