import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "@/utils/directory.utils";
import { assertNoSymbolicLinks } from "./symlink.guard";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

describe("assertNoSymbolicLinks", () => {
	test("accepts a tree of regular files and directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-symlink-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "index.mjs"), "export default {};\n");
		await writeFile(join(root, "nested", "data.txt"), "data");

		await expect(assertNoSymbolicLinks(root, 4)).resolves.toBeUndefined();
	});

	test("rejects a symbolic link at the top level", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-symlink-"));
		temporaryDirectories.push(root);
		await writeFile(join(root, "real.txt"), "content");
		await symlink(join(root, "real.txt"), join(root, "linked.txt"));

		await expect(assertNoSymbolicLinks(root, 4)).rejects.toMatchObject({ category: "validation", code: "plugin.package_symlink_invalid" });
	});

	test("rejects a symbolic link nested in a subdirectory", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-symlink-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(join(root, "assets", "real.txt"), "content");
		await symlink(join(root, "assets", "real.txt"), join(root, "assets", "linked.txt"));

		await expect(assertNoSymbolicLinks(root, 4)).rejects.toMatchObject({ category: "validation", code: "plugin.package_symlink_invalid" });
	});
});
