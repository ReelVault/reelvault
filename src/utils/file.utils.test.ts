import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { removeTree } from "@/utils/directory.utils";
import { checkFileExistence, consumeStreamBounded, withTempPath, writeFileAtomic, writeFileIfChanged } from "./file.utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

/** A body made of fixed chunks, so each read boundary is deterministic. */
function bodyOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("consumeStreamBounded", () => {
	test("hands every chunk to the consumer with the running byte count", async () => {
		const received: number[] = [];

		const total = await consumeStreamBounded(bodyOf(new Uint8Array(2), new Uint8Array(3)), {
			maxBytes: 10,
			overflow: () => new Error("overflow"),
			onChunk: (_chunk, receivedBytes) => {
				received.push(receivedBytes);
			},
		});

		expect(total).toBe(5);
		expect(received).toEqual([2, 5]);
	});

	test("fails with the caller's overflow error before handing over the excess chunk", async () => {
		const overflow = new Error("too large");
		const received: number[] = [];

		await expect(
			consumeStreamBounded(bodyOf(new Uint8Array(6), new Uint8Array(6)), {
				maxBytes: 10,
				overflow: () => overflow,
				onChunk: (_chunk, receivedBytes) => {
					received.push(receivedBytes);
				},
			}),
		).rejects.toBe(overflow);
		expect(received).toEqual([6]);
	});

	test("stops before reading when the signal is already aborted, handing over no chunk", async () => {
		const controller = new AbortController();
		const cancellation = new Error("cancelled");
		controller.abort(cancellation);
		const received: number[] = [];

		await expect(
			consumeStreamBounded(bodyOf(new Uint8Array(1)), {
				maxBytes: 10,
				signal: controller.signal,
				overflow: () => new Error("overflow"),
				onChunk: (_chunk, receivedBytes) => {
					received.push(receivedBytes);
				},
			}),
		).rejects.toBe(cancellation);
		expect(received).toEqual([]);
	});
});

describe("writeFileIfChanged", () => {
	test("writes a missing file and skips an identical rewrite", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const target = join(directory, "sidecar.nfo");

		expect(await writeFileIfChanged(target, "same")).toBeTrue();
		expect(await writeFileIfChanged(target, "same")).toBeFalse();
		expect(await Bun.file(target).text()).toBe("same");
	});

	test("rewrites the file when the bytes differ", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const target = join(directory, "sidecar.nfo");
		await writeFileAtomic(target, "before");

		expect(await writeFileIfChanged(target, "after")).toBeTrue();
		expect(await Bun.file(target).text()).toBe("after");
	});
});

describe("withTempPath", () => {
	test("removes the temp file after the producer finishes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		let tempPath = "";

		const result = await withTempPath(join(directory, "catalog.sqlite"), ".tmp", async (path) => {
			tempPath = path;
			await write(path, "x");

			return 42;
		});

		expect(result).toBe(42);
		expect(await Bun.file(tempPath).exists()).toBeFalse();
	});
});

describe("checkFileExistence", () => {
	test("reports exists for a present file and missing for an absent one", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const present = join(directory, "present.txt");
		await write(present, "x");

		expect(await checkFileExistence(present)).toBe("exists");
		expect(await checkFileExistence(join(directory, "missing.txt"))).toBe("missing");
	});

	test("reports missing when the path sits under a regular file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);
		const present = join(directory, "present.txt");
		await write(present, "x");

		expect(await checkFileExistence(join(present, "child.txt"))).toBe("missing");
	});

	test("reports unavailable, never missing, when stat fails for another reason", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-file-utils-"));
		temporaryDirectories.push(directory);

		// A name past the filesystem limit fails with ENAMETOOLONG, which says nothing about whether the file exists.
		expect(await checkFileExistence(join(directory, "x".repeat(300)))).toBe("unavailable");
	});
});
