import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { file as bunFile } from "bun";
import { serverConfig } from "@/server.config";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { contentByteSize, writeFileWithRollback } from "./plugin.file-record.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("writeFileWithRollback", () => {
	test("keeps the file when the persist step succeeds", async () => {
		const dir = await mkdtemp(PathUtils.join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = PathUtils.join(dir, "artifact.bin");

		const persisted = await writeFileWithRollback(path, new Uint8Array([1, 2, 3]), async () => "recorded");

		expect(persisted).toBe("recorded");
		expect((await stat(path)).size).toBe(3);
	});

	test("deletes the just-written file when persist throws", async () => {
		const dir = await mkdtemp(PathUtils.join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = PathUtils.join(dir, "artifact.bin");

		await expect(
			writeFileWithRollback(path, new Uint8Array([9]), () => {
				throw new Error("db insert failed");
			}),
		).rejects.toThrow("db insert failed");

		expect(await FileUtils.exists(path)).toBe(false);
	});

	test("streams a temp-file Blob source and deletes it under the transcodes root", async () => {
		const transcodesDir = serverConfig.paths.transcodes;
		await mkdir(transcodesDir, { recursive: true });
		const sourceDir = await mkdtemp(PathUtils.join(transcodesDir, "rv-file-record-"));
		temporaryDirectories.push(sourceDir);
		const sourcePath = PathUtils.join(sourceDir, "sprite.webp");
		await Bun.write(sourcePath, new Uint8Array([1, 2, 3, 4]));

		const dir = await mkdtemp(PathUtils.join(tmpdir(), "rv-file-record-target-"));
		temporaryDirectories.push(dir);
		const targetPath = PathUtils.join(dir, "artifact.webp");

		const persisted = await writeFileWithRollback(targetPath, bunFile(sourcePath), async () => "recorded");

		expect(persisted).toBe("recorded");
		expect((await stat(targetPath)).size).toBe(4);
		// The temp source is removed by the write helper, not the caller.
		expect(await FileUtils.exists(sourcePath)).toBe(false);
	});

	test("propagates the persist result value", async () => {
		const dir = await mkdtemp(PathUtils.join(tmpdir(), "rv-file-record-"));
		temporaryDirectories.push(dir);
		const path = PathUtils.join(dir, "nested.bin");
		await mkdir(dir, { recursive: true });

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
