import { describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDirectory,
	deleteDirectory,
	deleteTemporaryDirectory,
	directoryExists,
	listDirectoryEntries,
	readDirectoryEntries,
	removeTree,
	scanFiles,
	scanFilesWithStats,
} from "@/utils/directory.utils";
import { readFile } from "@/utils/file.utils";

describe("directory entries", () => {
	test("reports each entry's name and type, and an unreadable directory as undefined", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-directory-utils-"));
		try {
			await writeFile(join(root, "file.txt"), "x");
			await createDirectory(join(root, "nested"));

			const entries = await readDirectoryEntries(root);
			expect(entries.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
				{ name: "file.txt", isFile: true, isDirectory: false },
				{ name: "nested", isFile: false, isDirectory: true },
			]);
			expect(await listDirectoryEntries(join(root, "missing"))).toBeUndefined();
		} finally {
			await removeTree(root);
		}
	});
});

describe("DirUtils", () => {
	test("refuses to delete directories containing video files", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-directory-utils-"));
		const videoPath = join(root, "nested", "movie.mkv");
		await createDirectory(join(root, "nested"));
		await writeFile(videoPath, "video placeholder");

		try {
			expect(await deleteDirectory(root)).toBe(false);
			expect(await readFile(videoPath, "utf8")).toBe("video placeholder");
		} finally {
			await removeTree(root);
		}
	});

	test("deletes temporary directories containing generated video files", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-directory-utils-"));
		const videoPath = join(root, "movie.m4s");
		await writeFile(videoPath, "segment placeholder");

		try {
			expect(await deleteTemporaryDirectory(root)).toBe(true);
			expect(await directoryExists(root)).toBe(false);
		} finally {
			await removeTree(root);
		}
	});

	test("scanFiles returns file paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-dir-scan-"));
		const videoPath = join(root, "movie.mp4");
		await writeFile(videoPath, "video sample");

		try {
			const files = await scanFiles(root, ["mp4"]);
			expect(files).toEqual([videoPath]);
		} finally {
			await removeTree(root);
		}
	});

	test("scanFilesWithStats returns file paths with size and mtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-dir-stats-"));
		const videoPath = join(root, "movie.mp4");
		await writeFile(videoPath, "video content sample");

		try {
			const entries = await scanFilesWithStats(root, ["mp4"]);
			const { mtimeMs } = await stat(videoPath);
			expect(entries).toEqual([{ filePath: videoPath, size: "video content sample".length, mtimeMs: Math.floor(mtimeMs) }]);
		} finally {
			await removeTree(root);
		}
	});

	test("scanFiles skips dot-prefixed files and directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-dir-hidden-"));
		await writeFile(join(root, "movie.mp4"), "visible");
		await writeFile(join(root, ".hidden.mp4"), "hidden file");
		const hiddenDir = join(root, ".hidden-dir");
		await createDirectory(hiddenDir);
		await writeFile(join(hiddenDir, "nested.mp4"), "hidden dir");

		try {
			const files = await scanFiles(root, ["mp4"]);
			expect(files).toEqual([join(root, "movie.mp4")]);
		} finally {
			await removeTree(root);
		}
	});
});
