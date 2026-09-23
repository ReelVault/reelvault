import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { FileUtils } from "./file.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
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
});
