import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { scanFiles as actualScanFiles, scanFilesWithStats as actualScanFilesWithStats, removeTreeSync } from "@/utils/directory.utils";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { FileScannerService, fileScannerService, matchesIgnorePattern } from "./file.scanner";

// The mock replaces the module, so the real implementations are captured before
// it lands: a mock that called back into the module it replaces would recurse.
const realScanFiles = actualScanFiles;
const realScanFilesWithStats = actualScanFilesWithStats;

let scanFilesWithStatsImpl = realScanFilesWithStats;
mockModuleWithRealExports("@/utils/directory.utils", {
	scanFiles: realScanFiles,
	scanFilesWithStats: (...args: Parameters<typeof scanFilesWithStatsImpl>) => scanFilesWithStatsImpl(...args),
});

let root: string;

beforeAll(() => {
	root = join(tmpdir(), `reelvault-file-scanner-${crypto.randomUUID()}`);
	mkdirSync(join(root, "nested", "deeper"), { recursive: true });
	writeFileSync(join(root, "movie.mkv"), "x");
	writeFileSync(join(root, "sample.mkv"), "x");
	writeFileSync(join(root, "note.txt"), "x");
	writeFileSync(join(root, "nested", "episode.mp4"), "x");
	writeFileSync(join(root, "nested", "deeper", "extra.avi"), "x");
});

afterAll(() => {
	removeTreeSync(root);
	// The next test file must get the real module back.
	restoreModuleMocks();
});

describe("FileScannerService.scan", () => {
	test("scans recursively, filters by extension and skips sample files", async () => {
		const files = await fileScannerService.scan({ paths: [root], extensions: [".mkv", ".mp4", ".avi"] });

		expect(files.map((file) => basename(file)).toSorted()).toEqual(["episode.mp4", "extra.avi", "movie.mkv"]);
	});

	test("respects maxDepth", async () => {
		const shallow = await fileScannerService.scan({ paths: [root], extensions: [".mkv", ".mp4", ".avi"], maxDepth: 1 });

		expect(shallow).toEqual([join(root, "movie.mkv")]);
	});

	test("merges results across overlapping roots without duplicates", async () => {
		const files = await fileScannerService.scan({ paths: [root, join(root, "nested")], extensions: [".mkv"] });

		expect(files).toEqual([join(root, "movie.mkv")]);
	});
});

describe("FileScannerService.scanWithStats", () => {
	test("returns resolved paths with size and mtime", async () => {
		const target = join(root, "movie.mkv");
		utimesSync(target, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

		const entries = await fileScannerService.scanWithStats({ paths: [root], extensions: [".mkv"] });

		expect(entries).toHaveLength(1);
		const entry = entries[0];
		if (!entry) throw new Error("Expected one scanned entry");

		expect(entry.filePath).toBe(target);
		expect(entry.size).toBeGreaterThan(0);
		expect(entry.mtimeMs).toBe(1_700_000_000_000);
	});

	test("merges every file when the walk spans multiple stat batches", async () => {
		const batchRoot = join(root, "stat-batches");
		mkdirSync(batchRoot, { recursive: true });
		for (let index = 0; index < 513; index++) writeFileSync(join(batchRoot, `movie-${index}.mkv`), "x");

		const entries = await fileScannerService.scanWithStats({ paths: [batchRoot], extensions: [".mkv"] });

		expect(entries).toHaveLength(513);
		expect(new Set(entries.map((entry) => entry.filePath)).size).toBe(513);
	});
});

describe("matchesIgnorePattern", () => {
	const root = "/media/library";

	test("name-only patterns match anywhere in the tree", () => {
		expect(matchesIgnorePattern("/media/library/Samples/clip.mkv", root, ["sample*"])).toBe(true);
		expect(matchesIgnorePattern("/media/library/clip.sample.mkv", root, ["*.sample.*"])).toBe(true);
		expect(matchesIgnorePattern("/media/library/movie.mkv", root, ["sample*"])).toBe(false);
	});

	test("path patterns anchor to the scan root", () => {
		expect(matchesIgnorePattern("/media/library/behind the scenes/clip.mkv", root, ["behind the scenes/*"])).toBe(true);
		expect(matchesIgnorePattern("/media/library/movie.mkv", root, ["extras/*"])).toBe(false);
	});

	test("question mark matches a single character", () => {
		expect(matchesIgnorePattern("/media/library/s1e1.mkv", root, ["s?e?.mkv"])).toBe(true);
	});

	test("matching is case-insensitive and pattern-less lists disable filtering", () => {
		expect(matchesIgnorePattern("/media/library/TEMP.mkv", root, ["temp*"])).toBe(true);
		expect(matchesIgnorePattern("/media/library/movie.mkv", root, [])).toBe(false);
	});
});

describe("FileScannerService path timeout", () => {
	test("skips a path whose scan exceeds the deadline instead of hanging", async () => {
		const scanner = new FileScannerService(20);
		scanFilesWithStatsImpl = () =>
			new Promise<never>(() => {
				// Never settles — the per-path timeout is what ends the scan.
			});
		const stub = {
			restore: () => {
				scanFilesWithStatsImpl = actualScanFilesWithStats;
			},
		};
		try {
			const entries = await scanner.scanWithStats({ paths: [root], extensions: [".mkv"] });

			expect(entries).toEqual([]);
		} finally {
			stub.restore();
		}
	});
});
