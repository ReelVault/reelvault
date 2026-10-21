import { afterAll, afterEach, expect, test } from "bun:test";
import type { Logger } from "@reelvault/sdk/common";
import { subtitlesRepository } from "@/app/repositories/subtitles.repository";
import { scanFilesWithStats as actualScanFilesWithStats } from "@/utils/directory.utils";
import { deleteFile as actualDeleteFile } from "@/utils/file.utils";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { cleanupOrphanSubtitlesWorker } from "./cleanup-orphan-subtitles.worker";

// The mocks replace the modules, so the real implementations are captured
// before they land: a mock that called back into the module it replaces would
// recurse.
const realScanFilesWithStats = actualScanFilesWithStats;
const realDeleteFile = actualDeleteFile;

let scanFilesWithStatsImpl = realScanFilesWithStats;
let deleteFileImpl: (path: string) => Promise<boolean> = realDeleteFile;
mockModuleWithRealExports("@/utils/directory.utils", {
	scanFilesWithStats: (...args: Parameters<typeof scanFilesWithStatsImpl>) => scanFilesWithStatsImpl(...args),
});
mockModuleWithRealExports("@/utils/file.utils", {
	deleteFile: (path: string) => deleteFileImpl(path),
});

const HOUR_MS = 3_600_000;
const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	scanFilesWithStatsImpl = realScanFilesWithStats;
	deleteFileImpl = realDeleteFile;
	for (const stub of activeStubs.splice(0)) stub.restore();
});

// The next test file must get the real modules back.
afterAll(() => {
	restoreModuleMocks();
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
	scanFilesWithStatsImpl = () =>
		Promise.resolve([
			{ filePath: "/subs/keep.vtt", size: 10, mtimeMs: olderThanGrace },
			{ filePath: "/subs/orphan.vtt", size: 10, mtimeMs: olderThanGrace },
		]);
	activeStubs.push(stubMethod(subtitlesRepository, "findAllIds", () => Promise.resolve(new Set(["keep"]))));
	const deleted: string[] = [];
	deleteFileImpl = (path: string) => {
		deleted.push(path);

		return Promise.resolve(true);
	};

	const result = await runSweep();

	expect(deleted).toEqual(["/subs/orphan.vtt"]);
	expect(result).toEqual({ success: true, deleted: 1 });
});

test("keeps an orphan newer than the grace period — an extraction may still be running", async () => {
	scanFilesWithStatsImpl = () => Promise.resolve([{ filePath: "/subs/orphan.vtt", size: 10, mtimeMs: Date.now() }]);
	activeStubs.push(stubMethod(subtitlesRepository, "findAllIds", () => Promise.resolve(new Set())));
	let deleteCalls = 0;
	deleteFileImpl = () => {
		deleteCalls += 1;

		return Promise.resolve(true);
	};

	const result = await runSweep();

	expect(deleteCalls).toBe(0);
	expect(result).toEqual({ success: true, deleted: 0 });
});
