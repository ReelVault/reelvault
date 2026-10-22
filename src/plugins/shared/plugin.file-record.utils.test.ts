import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { file as bunFile } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { removeTree } from "@/utils/directory.utils";
import { fileExists } from "@/utils/file.utils";
import { contentByteSize, writeFileWithRollback } from "./plugin.file-record.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTree(directory)));
});

describe("writeFileWithRollback", () => {
	test("keeps the file when the persist step succeeds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = join(dir, "artifact.bin");

		const persisted = await writeFileWithRollback(path, new Uint8Array([1, 2, 3]), async () => "recorded");

		expect(persisted).toBe("recorded");
		expect((await stat(path)).size).toBe(3);
	});

	test("deletes the just-written file when persist throws", async () => {
		const insertError = new Error("db insert failed");
		const dir = await mkdtemp(join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = join(dir, "artifact.bin");

		await expect(
			writeFileWithRollback(path, new Uint8Array([9]), () => {
				throw insertError;
			}),
		).rejects.toBe(insertError);

		expect(await fileExists(path)).toBe(false);
	});

	test("streams a temp-file Blob source and deletes it under the transcodes root", async () => {
		const transcodesDir = serverConfig.paths.transcodes;
		await mkdir(transcodesDir, { recursive: true });
		const sourceDir = await mkdtemp(join(transcodesDir, "rv-file-record-"));
		temporaryDirectories.push(sourceDir);
		const sourcePath = join(sourceDir, "sprite.webp");
		await Bun.write(sourcePath, new Uint8Array([1, 2, 3, 4]));

		const dir = await mkdtemp(join(tmpdir(), "rv-file-record-target-"));
		temporaryDirectories.push(dir);
		const targetPath = join(dir, "artifact.webp");

		const persisted = await writeFileWithRollback(targetPath, bunFile(sourcePath), async () => "recorded");

		expect(persisted).toBe("recorded");
		expect((await stat(targetPath)).size).toBe(4);
		// The temp source is removed by the write helper, not the caller.
		expect(await fileExists(sourcePath)).toBe(false);
	});

	test("keeps a Blob source that lies outside the transcodes root", async () => {
		const sourceDir = await mkdtemp(join(tmpdir(), "rv-file-record-source-"));
		temporaryDirectories.push(sourceDir);
		const sourcePath = join(sourceDir, "upload.webp");
		await Bun.write(sourcePath, new Uint8Array([1, 2, 3, 4]));

		const dir = await mkdtemp(join(tmpdir(), "rv-file-record-target-"));
		temporaryDirectories.push(dir);
		const targetPath = join(dir, "artifact.webp");

		await writeFileWithRollback(targetPath, bunFile(sourcePath), async () => "recorded");

		expect((await stat(targetPath)).size).toBe(4);
		expect(await fileExists(sourcePath)).toBe(true);
	});

	test("propagates the persist result value", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = join(dir, "nested.bin");

		const value = { id: "row-1" } as const;
		expect(await writeFileWithRollback(path, new Uint8Array([0]), async () => value)).toEqual(value);
	});
});

describe("contentByteSize", () => {
	test("reports Blob.size for blobs and byteLength for binary payloads", () => {
		expect(contentByteSize(new Blob(["hello"]))).toBe(5);
		expect(contentByteSize(new Uint8Array(7))).toBe(7);
	});
});
