import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { FileUtils } from "./file.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

describe("FileUtils.existence", () => {
	test("reports exists for a present file and missing for an absent one", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const present = join(directory, "present.txt");
		await write(present, "x");

		expect(await FileUtils.existence(present)).toBe("exists");
		expect(await FileUtils.existence(join(directory, "missing.txt"))).toBe("missing");
	});

	test("reports missing when the path sits under a regular file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const present = join(directory, "present.txt");
		await write(present, "x");

		expect(await FileUtils.existence(join(present, "child.txt"))).toBe("missing");
	});

	test("reports unavailable, never missing, when stat fails for another reason", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);

		// A name past the filesystem limit fails with ENAMETOOLONG, which says nothing about whether the file exists.
		expect(await FileUtils.existence(join(directory, "x".repeat(300)))).toBe("unavailable");
	});
});
