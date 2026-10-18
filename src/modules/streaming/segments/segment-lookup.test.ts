import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { SegmentLookup, type SegmentWaitContext } from "./segment.lookup";

/**
 * The file-system calls (exists, waitForFile, readFile) are the process boundary, so
 * the harness supplies them. The wait ladder and the error mapping are the real lookup's.
 */
function createHarness(options: { existing?: boolean; waitOutcome?: "ok" | "timeout" } = {}) {
	const calls: Array<{ path: string; timeoutMs: number }> = [];
	const waitError = new Error("timeout");
	const fileToken = file("/dev/null");
	const lookup = new SegmentLookup({
		initialWaitMs: 8_000,
		seekWaitMs: 10_000,
		exists: async () => options.existing ?? false,
		waitForFile: (path: string, timeoutMs: number) => {
			calls.push({ path, timeoutMs });
			if (options.waitOutcome === "timeout") throw waitError;
		},
		readFile: (path: string) => {
			if (path.endsWith("enoent")) {
				const error = Object.assign(new Error("not found"), { code: "ENOENT" });
				throw error;
			}

			return fileToken;
		},
	});

	return { lookup, calls, fileToken, waitError };
}

function createContext(overrides: Partial<SegmentWaitContext> = {}): SegmentWaitContext {
	return {
		segment: "seg_5.m4s",
		filePath: "/tmp/session-1/seg_5.m4s",
		isSeeking: () => false,
		isNearActiveWindow: false,
		...overrides,
	};
}

describe("segment lookup", () => {
	test("returns the file immediately when it exists", async () => {
		const { lookup, calls, fileToken } = createHarness({ existing: true });

		const result = await lookup.find(createContext());

		expect(result).toBe(fileToken);
		expect(calls).toEqual([]);
	});

	test("returns the file after the initial wait succeeds", async () => {
		const { lookup, calls, fileToken } = createHarness({ waitOutcome: "ok" });

		const result = await lookup.find(createContext());

		expect(result).toBe(fileToken);
		expect(calls).toEqual([{ path: "/tmp/session-1/seg_5.m4s", timeoutMs: 8_000 }]);
	});

	test("reports init segments as failed generation instead of seeking", async () => {
		const { lookup } = createHarness({ waitOutcome: "timeout" });

		await expect(lookup.find(createContext({ segment: "init.mp4", filePath: "/tmp/session-1/init.mp4" }))).rejects.toMatchObject({
			category: "not_found",
			code: "init_segment_not_found",
		});
	});

	test("keeps waiting while a seek is in progress, then gives up", async () => {
		const { lookup, calls } = createHarness({ waitOutcome: "timeout" });

		await expect(lookup.find(createContext({ isSeeking: () => true }))).rejects.toMatchObject({
			code: "stream.segment_not_found",
			params: { segment: "seg_5.m4s" },
		});
		expect(calls.map((call) => call.timeoutMs)).toEqual([8_000, 10_000]);
	});

	test("rejects not-yet-generated segments near the active window", async () => {
		const { lookup } = createHarness({ waitOutcome: "timeout" });

		await expect(lookup.find(createContext({ isNearActiveWindow: true }))).rejects.toMatchObject({
			code: "stream.segment_not_ready",
			params: { segment: "seg_5.m4s" },
		});
	});

	test("returns no file for a far-future segment, so the caller starts an implicit seek", async () => {
		const { lookup } = createHarness({ waitOutcome: "timeout" });

		const result = await lookup.find(createContext());

		expect(result).toBeUndefined();
	});

	test("readAfterSeek waits the recovery window and returns the file", async () => {
		const { lookup, calls, fileToken } = createHarness({ waitOutcome: "ok" });

		const result = await lookup.readAfterSeek(createContext(), 15_000);

		expect(result).toBe(fileToken);
		expect(calls).toEqual([{ path: "/tmp/session-1/seg_5.m4s", timeoutMs: 15_000 }]);
	});

	test("readAfterSeek fails with not found when the seek does not produce the segment", async () => {
		const { lookup } = createHarness({ waitOutcome: "timeout" });

		await expect(lookup.readAfterSeek(createContext(), 15_000)).rejects.toMatchObject({
			code: "stream.segment_not_found",
			params: { segment: "seg_5.m4s" },
		});
	});

	test("rethrows when the request is aborted during the wait", async () => {
		const { lookup, waitError } = createHarness({ waitOutcome: "timeout" });
		const controller = new AbortController();
		controller.abort();

		await expect(lookup.find(createContext({ signal: controller.signal }))).rejects.toBe(waitError);
	});

	test("maps ENOENT reads to a request timeout (segment removed by seek restart)", async () => {
		const { lookup } = createHarness({ existing: true });

		await expect(lookup.find(createContext({ filePath: "/tmp/session-1/seg_5.m4s/enoent" }))).rejects.toMatchObject({
			category: "timeout",
			code: "stream.segment_removed",
		});
	});
});
