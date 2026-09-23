import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileScannerService } from "./file-scanner";

let root: string;

beforeAll(() => {
	root = join(tmpdir(), `reelvault-file-scanner-${crypto.randomUUID()}`);
	mkdirSync(join(root, "nested", "deeper"), { recursive: true });
	writeFileSync(join(root, "movie.mkv"), "x");
	writeFileSync(join(root, "note.txt"), "x");
	writeFileSync(join(root, "nested", "episode.mp4"), "x");
	writeFileSync(join(root, "nested", "deeper", "extra.avi"), "x");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("FileScannerService.scan", () => {
	test("scans recursively, filters by extension and dedupes", async () => {
		const files = await fileScannerService.scan({ paths: [root], extensions: [".mkv", ".mp4", ".avi"] });

		expect(files).toHaveLength(3);
		expect(files.map((file) => file.endsWith(".txt"))).not.toContain(true);
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
});

describe("FileScannerService.diff", () => {
	test("splits new and removed files, ignoring database paths outside the roots", () => {
		const changes = fileScannerService.diff([join(root, "movie.mkv")], [join(root, "movie.mkv"), "/elsewhere/old.mkv"], [root]);

		expect(changes.newFiles).toEqual([]);
		expect(changes.removedFiles).toEqual([]);
	});

	test("reports genuinely removed files", () => {
		const changes = fileScannerService.diff([], [join(root, "gone.mkv")], [root]);

		expect(changes.removedFiles).toEqual([join(root, "gone.mkv")]);
	});
});
