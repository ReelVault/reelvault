import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, fixture, group, main, printTable, suiteArgs, task } from "benchkit";
import { ReelVaultFormatAdapter } from "@/modules/metadata-sidecars/formats/reelvault/reelvault-format.adapter";
import { SqliteOfflineCatalogRebuildService } from "@/modules/metadata-sidecars/offline-catalog-rebuild";
import type { SidecarSnapshotDocument } from "@/modules/metadata-sidecars/sidecar.types";
import { readXmlDocument } from "@/modules/metadata-sidecars/xml/xml-document.reader";
import { writeXmlDocument } from "@/modules/metadata-sidecars/xml/xml-writer";

export const meta = { description: "Sidecar formats (XML round-trip, adapter file I/O, offline catalog rebuild)" };

/**
 * Metadata sidecar suite. Zero coverage before this existed. Three layers:
 *  1. XML writer/reader round-trip (pure string functions),
 *  2. the ReelVault adapter's file write + read (atomic file I/O included),
 *  3. the offline catalog rebuild over a synthetic on-disk library tree
 *     (video file + movie.reelvault.nfo per title → fresh SQLite catalog).
 *
 * Runs in-process against a throwaway tmpdir — no server, no app database.
 */

function buildSnapshot(index: number): SidecarSnapshotDocument {
	return {
		reelvaultSchemaVersion: 1,
		title: `Benchmark Movie ${index}`,
		originalTitle: `Benchmark Movie ${index}`,
		releaseDate: "2024-06-15",
		year: 2024,
		overview: "Benchmark overview text long enough to resemble a real sidecar payload entry.".repeat(3),
		tagline: "Benchmark tagline",
		status: "released",
		identifiers: { imdbId: `tt${String(10_000_000 + index)}`, tmdbId: String(1_000_000 + index) },
		providerIds: { tmdb: String(1_000_000 + index) },
		genres: ["Action", "Adventure", "Sci-Fi"],
		keywords: ["benchmark", "space", "odyssey"],
		productionCompanies: ["Benchmark Pictures"],
		cast: Array.from({ length: 12 }, (_, castIndex) => ({
			name: `Person ${index}-${castIndex}`,
			character: `Role ${castIndex}`,
			order: castIndex,
		})),
		crew: [
			{ name: `Director ${index}`, job: "Director" },
			{ name: `Writer ${index}`, job: "Screenplay" },
		],
		ratings: [{ source: "tmdb", value: (index % 100) / 10, voteCount: 1000 + index }],
	};
}

function writeSidecarTree(root: string, movieCount: number): void {
	const adapter = new ReelVaultFormatAdapter();
	const queue: Array<Promise<unknown>> = [];
	for (let index = 0; index < movieCount; index++) {
		const directory = join(root, `Movie ${String(index).padStart(5, "0")}`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "movie.mp4"), "benchmark placeholder video bytes");
		queue.push(
			adapter.write({
				documentPath: join(directory, "movie.reelvault.nfo"),
				document: buildSnapshot(index),
			}),
		);
	}
}

const args = suiteArgs();

if (!args.help) {
	const rootFixture = fixture("sidecars-root", ({ onCleanup }) => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-benchmark-sidecars-"));
		onCleanup(() => {
			rmSync(root, { recursive: true, force: true });
		});
		mkdirSync(join(root, "adapter"), { recursive: true });

		return root;
	});

	// ─── 1. Offline catalog rebuild (runs first: its table precedes the micro tables) ───
	task("sidecars: offline catalog rebuild", async () => {
		const root = await rootFixture();
		const treeRoot = join(root, "library");
		const movieCount = Math.max(50, Math.min(2000, args.rows / 25));
		writeSidecarTree(treeRoot, movieCount);

		const rebuild = new SqliteOfflineCatalogRebuildService();
		const outputDatabasePath = join(root, "catalog.sqlite");
		const rebuildStartedAt = performance.now();
		const report = await rebuild.rebuild({ libraries: [{ id: "lib-benchmark", type: "movies", paths: [treeRoot] }], outputDatabasePath });
		const rebuildMs = performance.now() - rebuildStartedAt;

		printTable(
			`Offline catalog rebuild (${movieCount} movies on disk)`,
			["wall clock", "imported movies", "imported media files", "skipped"],
			[
				[
					`${(rebuildMs / 1000).toFixed(2)}s`,
					String(report.importedMovies),
					String(report.importedMediaFiles),
					String(report.skipped.length),
				],
			],
		);

		return { ok: true, data: { movieCount, ...report } };
	});

	// ─── 2. Pure XML round-trip + adapter file write/read ───
	const document = buildSnapshot(0);
	const serialized = writeXmlDocument({
		rootName: "reelvault",
		values: { reelvaultSchemaVersion: 1, snapshot: JSON.stringify(document) },
	});
	const parsedBack = readXmlDocument(serialized);
	console.log(`[sidecars] xml document: ${serialized.length} bytes, round-trip parsed: ${parsedBack ? "ok" : "FAILED"}`);

	const adapter = new ReelVaultFormatAdapter();

	group("XML + adapter (per call)", () => {
		bench("writeXmlDocument (snapshot → xml string)", () => {
			const output = writeXmlDocument({
				rootName: "reelvault",
				values: { reelvaultSchemaVersion: 1, snapshot: JSON.stringify(document) },
			});
			if (output.length === 0) throw new Error("empty xml");
		});
		bench("readXmlDocument (xml string → values)", () => {
			const parsed = readXmlDocument(serialized);
			if (!parsed) throw new Error("parse failed");
		});
		bench("adapter.write (xml + atomic file write)", async () => {
			const adapterDir = join(await rootFixture(), "adapter");
			await adapter.write({ documentPath: join(adapterDir, "movie.reelvault.nfo"), document });
		});
		bench("adapter.read (file read + xml parse + snapshot JSON)", async () => {
			const adapterDir = join(await rootFixture(), "adapter");
			const canonical = await adapter.read({ documentPath: join(adapterDir, "movie.reelvault.nfo") });
			if (!canonical) throw new Error("adapter read failed");
		});
	});
}

await main(import.meta);
