import { afterEach, expect, test } from "bun:test";
import type { Logger } from "@reelvault/sdk/common";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { DirUtils } from "@/utils/directory.utils";
import { FileUtils } from "@/utils/file.utils";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { cleanupOrphanSubtitlesWorker } from "./cleanup-orphan-subtitles.worker";

const HOUR_MS = 3_600_000;
const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function noopLogger(): Logger {
	const noop = () => undefined;

	return {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		child: () => noopLogger(),
		time: () => () => undefined,
	};
}

async function runSweep() {
	return await cleanupOrphanSubtitlesWorker.handler({
		taskId: "task-1",
		workerId: "clean-up-orphan-subtitles",
		operationId: "operation-1",
		data: undefined,
		attempt: 1,
		signal: new AbortController().signal,
		logger: noopLogger(),
	});
}

test("deletes only extracted files without a subtitle row", async () => {
	const olderThanGrace = Date.now() - HOUR_MS;
	activeStubs.push(
		stubMethod(DirUtils, "scanFilesWithStats", () =>
			Promise.resolve([
				{ filePath: "/subs/keep.vtt", size: 10, mtimeMs: olderThanGrace },
				{ filePath: "/subs/orphan.vtt", size: 10, mtimeMs: olderThanGrace },
			]),
		),
		stubMethod(subtitlesRepository, "findAllIds", () => Promise.resolve(new Set(["keep"]))),
	);
	const deleted: string[] = [];
	activeStubs.push(
		stubMethod(FileUtils, "delete", (path: string) => {
			deleted.push(path);

			return Promise.resolve(true);
		}),
	);

	const result = await runSweep();

	expect(deleted).toEqual(["/subs/orphan.vtt"]);
	expect(result).toEqual({ success: true, deleted: 1 });
});

test("keeps an orphan newer than the grace period — an extraction may still be running", async () => {
	activeStubs.push(
		stubMethod(DirUtils, "scanFilesWithStats", () => Promise.resolve([{ filePath: "/subs/orphan.vtt", size: 10, mtimeMs: Date.now() }])),
		stubMethod(subtitlesRepository, "findAllIds", () => Promise.resolve(new Set())),
	);
	let deleteCalls = 0;
	activeStubs.push(
		stubMethod(FileUtils, "delete", () => {
			deleteCalls += 1;

			return Promise.resolve(true);
		}),
	);

	const result = await runSweep();

	expect(deleteCalls).toBe(0);
	expect(result).toEqual({ success: true, deleted: 0 });
});
