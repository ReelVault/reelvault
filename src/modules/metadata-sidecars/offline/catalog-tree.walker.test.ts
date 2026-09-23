import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogTreeWalker, findMatchingFiles } from "./catalog-tree.walker";

describe("CatalogTreeWalker", () => {
	test("collects every file and subdirectory grouped by parent path", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-walker-"));
		await mkdir(join(root, "a"), { recursive: true });
		await mkdir(join(root, "b", "c"), { recursive: true });
		await Promise.all([
			writeFile(join(root, "root.nfo"), "x"),
			writeFile(join(root, "a", "file.mkv"), "x"),
			writeFile(join(root, "b", "c", "deep.mkv"), "x"),
		]);

		try {
			const tree = await new CatalogTreeWalker({ listEntries: defaultListEntries, getIoConcurrency: () => 4 }).collect(root);
			const rootNode = tree.get(root);
			expect(rootNode?.files).toEqual([join(root, "root.nfo")]);
			expect(rootNode?.subdirectories.toSorted()).toEqual([join(root, "a"), join(root, "b")]);
			expect(tree.get(join(root, "b", "c"))?.files).toEqual([join(root, "b", "c", "deep.mkv")]);
			expect(tree.get(join(root, "a"))?.subdirectories).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("treats an unreadable directory as empty", async () => {
		const tree = await new CatalogTreeWalker({
			listEntries: (directory) =>
				directory === "/media/broken"
					? Promise.reject(new Error("EACCES"))
					: Promise.resolve([
							{ name: "broken", isFile: false, isDirectory: true },
							{ name: "file.mkv", isFile: true, isDirectory: false },
						]),
			getIoConcurrency: () => 2,
		}).collect("/media");

		expect(tree.get("/media")?.files).toEqual(["/media/file.mkv"]);
		expect(tree.get("/media/broken")).toEqual({ files: [], subdirectories: [] });
	});
});

describe("findMatchingFiles", () => {
	const tree = new Map<string, { files: string[]; subdirectories: string[] }>([
		["/lib", { files: ["/lib/root.mkv"], subdirectories: ["/lib/show"] }],
		["/lib/show", { files: ["/lib/show/s01e01.mkv"], subdirectories: ["/lib/show/season"] }],
		["/lib/show/season", { files: ["/lib/show/season/s01e02.mkv"], subdirectories: [] }],
	]);

	test("matches recursively by default", () => {
		const matched = findMatchingFiles(tree, "/lib", (path) => path.endsWith(".mkv"));

		expect(matched).toEqual(["/lib/root.mkv", "/lib/show/s01e01.mkv", "/lib/show/season/s01e02.mkv"]);
	});

	test("recursive:false only matches files directly inside the directory", () => {
		const matched = findMatchingFiles(tree, "/lib/show", (path) => path.endsWith(".mkv"), { recursive: false });

		expect(matched).toEqual(["/lib/show/s01e01.mkv"]);
	});

	test("an unknown directory matches nothing", () => {
		expect(findMatchingFiles(tree, "/missing", () => true)).toEqual([]);
	});
});

async function defaultListEntries(directory: string) {
	const entries = await readdir(directory, { withFileTypes: true });

	return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
}
