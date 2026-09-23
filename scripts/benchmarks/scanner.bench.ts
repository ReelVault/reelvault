import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, fixture, main, suiteArgs } from "benchkit";
import { parseFileName } from "@/modules/recognition/utils/recognition.utils";
import { fileScannerService } from "@/modules/scanner/disk/file-scanner";
import { filterPathsWithinRoots } from "@/modules/scanner/utils/scanner.utils";

export const meta = { description: "File scanner & recognition (directory walk, diff, parseFileName caching)" };

const DIRECTORY_COUNT = 20;
const FILES_PER_DIR = 100;

async function createFixture(root: string): Promise<string[]> {
	const scanPaths: string[] = [];
	for (let directoryIndex = 0; directoryIndex < DIRECTORY_COUNT; directoryIndex += 1) {
		const directory = join(root, `library-${directoryIndex}`);
		await mkdir(directory, { recursive: true });
		scanPaths.push(directory);
		const files = Array.from({ length: FILES_PER_DIR }, (_, fileIndex) => {
			let extension = ".mp4";
			if (fileIndex % 10 === 0) {
				extension = ".txt";
			} else if (fileIndex % 2 === 0) {
				extension = ".mkv";
			}

			return writeFile(join(directory, `Title.Odyssey.S01E0${(fileIndex % 9) + 1}.1080p${extension}`), "");
		});
		await Promise.all(files);
	}

	return scanPaths;
}

const args = suiteArgs();

if (!args.help) {
	let scannedFiles: string[] = [];
	const tree = fixture("scanner-tree", async ({ onCleanup }) => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-benchmark-scanner-"));
		onCleanup(() => {
			return rm(root, { recursive: true, force: true });
		});
		console.log(`[scanner] generating directory structure with ${DIRECTORY_COUNT * FILES_PER_DIR} files...`);

		return { root, scanPaths: await createFixture(root) };
	});

	bench(
		`Filesystem walk (${DIRECTORY_COUNT * FILES_PER_DIR} files)`,
		async () => {
			const { scanPaths } = await tree();
			scannedFiles = await fileScannerService.scan({ paths: scanPaths });

			return scannedFiles;
		},
		{ warmup: 2, iterations: 10 },
	);

	// Same walk, but stat'ing every file — the path the real scan uses to detect
	// size/mtime changes.
	bench(
		`Filesystem walk with stats (${DIRECTORY_COUNT * FILES_PER_DIR} stats)`,
		async () => {
			const { scanPaths } = await tree();

			return await fileScannerService.scanWithStats({ paths: scanPaths });
		},
		{ warmup: 2, iterations: 5 },
	);

	bench(
		"Library file diff (new vs removed files)",
		async () => {
			const { root, scanPaths } = await tree();
			const databasePaths = [...scannedFiles.slice(0, Math.floor(scannedFiles.length * 0.9)), join(root, "missing.mkv")];

			return fileScannerService.diff(scannedFiles, databasePaths, scanPaths);
		},
		{ warmup: 5, iterations: args.iterations },
	);

	// Root filtering resolves every DB path and compares against every root —
	// O(paths × roots) string work on large libraries.
	const filterPaths = Array.from({ length: 10_000 }, (_, index) => `/media/library-${index % 20}/movie-${index}.mkv`);
	const filterRoots = Array.from({ length: 20 }, (_, index) => `/media/library-${index}`);
	bench("filterPathsWithinRoots (10k paths, 20 roots)", () => filterPathsWithinRoots(filterPaths, filterRoots), {
		warmup: 5,
		iterations: args.iterations,
	});

	const sampleTitles = [
		"Inception.2010.1080p.BluRay.x264.DTS.mkv",
		"Breaking.Bad.S05E14.Ozymandias.720p.HDTV.mkv",
		"The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.2160p.UHD.BluRay.x265.mkv",
		"Stranger.Things.S04E09.Chapter.Nine.The.Piggyback.1080p.NF.WEB-DL.DDP5.1.Atmos.x264.mkv",
		"The.Matrix.1999.2160p.TrueHD.7.1.Atmos.DV.HEVC.REMASTERED.mkv",
	];

	bench(
		"Recognition filename parser (parseFileName regex & memoization)",
		() => {
			for (const title of sampleTitles) {
				parseFileName(title);
			}
		},
		{ warmup: 20, iterations: args.iterations * 10 },
	);

	// A corpus larger than the 10k memo cache so every batch is parsed fresh.
	const uniqueNames = Array.from({ length: 20_000 }, (_, index) => `Unique.Title.${index}.${2000 + (index % 25)}.1080p.BluRay.x264.mkv`);
	const parseWindows = Math.floor(uniqueNames.length / 100);
	bench(
		"parseFileName cold (rotating 20k unique names)",
		({ iteration }) => {
			const start = (Math.abs(iteration) % parseWindows) * 100;
			for (let index = 0; index < 100; index++) {
				const name = uniqueNames[start + index];
				if (name) parseFileName(name);
			}
		},
		{ warmup: 5, iterations: args.iterations },
	);
}

await main(import.meta);
