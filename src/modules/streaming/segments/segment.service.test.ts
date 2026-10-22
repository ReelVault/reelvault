import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { removeTree } from "@/utils/directory.utils";
import { ImplicitSeekCoordinator } from "./implicit-seek.coordinator";
import { SegmentLookup } from "./segment.lookup";
import { SegmentService, type ServiceDependencies } from "./segment.service";

const SEGMENT = "seg_5.m4s";
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await removeTree(directory)));
});

function createService(options: { seeking?: boolean | undefined; seekArmed?: boolean | undefined; obsolete?: boolean | undefined } = {}) {
	const sessionDir = mkdtempSync(join(tmpdir(), "reelvault-segments-"));
	temporaryDirectories.push(sessionDir);
	const calls = {
		keepAlive: [] as string[],
		seekTo: [] as Array<{ sessionId: string; startTime: number }>,
		broadcasts: [] as Array<{ event: string; payload: unknown }>,
		requireSession: [] as string[],
	};
	// The encoder writes the segment only once the implicit seek has restarted it.
	let seeked = false;

	const segmentStartTime = options.obsolete ? 0 : 60;
	const runtime = {
		keepAlive: (sessionId: string) => {
			calls.keepAlive.push(sessionId);
		},
		beginSegment: () => {
			/* intentionally empty */
		},
		endSegment: () => {
			/* intentionally empty */
		},
		getSessionStartTime: () => 30,
		getSegmentInfo: () => ({ startTime: segmentStartTime, endTime: segmentStartTime + 4, index: 15, duration: 4 }),
		getFilePath: (_sessionId: string, name: string) => join(sessionDir, name),
		isSessionSeeking: () => options.seeking ?? false,
		getSessionDecision: () => (options.seekArmed === false ? undefined : createMockPlaybackDecision({ mode: "transcode" })),
		seekTo: async (sessionId: string, startTime: number) => {
			calls.seekTo.push({ sessionId, startTime });
			await writeFile(join(sessionDir, SEGMENT), "seeked segment bytes");
			seeked = true;

			return { startTime, reusedBuffer: false };
		},
	};

	// Only the wait for the encoder is stubbed: it stands in for ffmpeg's output. Existence checks and reads use the real file system.
	const lookup = new SegmentLookup({
		waitForFile: () => {
			if (!seeked) throw new Error("timeout");
		},
	});

	const implicitSeek = new ImplicitSeekCoordinator({
		sendToSession: (_sessionId, event, payload) => {
			calls.broadcasts.push({ event, payload });
		},
	});

	const dependencies: ServiceDependencies = {
		requireSession: (sessionId) => {
			calls.requireSession.push(sessionId);
		},
		runtime,
		lookup,
		implicitSeek,
	};

	return { service: new SegmentService(dependencies), calls, sessionDir };
}

describe("segment service", () => {
	test("serves an existing segment after keeping the session alive", async () => {
		const { service, calls, sessionDir } = createService();
		await writeFile(join(sessionDir, SEGMENT), "existing segment bytes");

		const result = await service.get("session-1", SEGMENT);

		expect(await result.text()).toBe("existing segment bytes");
		expect(calls.keepAlive).toEqual(["session-1"]);
		expect(calls.seekTo).toEqual([]);
	});

	test("rejects obsolete segments from before the session start", async () => {
		const { service } = createService({ obsolete: true });

		await expect(service.get("session-1", SEGMENT)).rejects.toMatchObject({ category: "not_found", code: "stream.segment_obsolete" });
	});

	test("rejects invalid segment names before touching the session", async () => {
		const { service, calls } = createService();

		await expect(service.get("session-1", "../escape.m4s")).rejects.toMatchObject({
			category: "validation",
			code: "stream.segment_name_invalid",
		});
		expect(calls.requireSession).toEqual([]);
	});

	test("triggers an implicit seek for far-future segments and announces it", async () => {
		const { service, calls } = createService();

		const result = await service.get("session-1", SEGMENT);

		expect(await result.text()).toBe("seeked segment bytes");
		expect(calls.seekTo).toEqual([{ sessionId: "session-1", startTime: 60 }]);
		expect(calls.broadcasts).toEqual([
			{ event: "playback:session:seeked", payload: { sessionId: "session-1", startTime: 60, position: 60 } },
		]);
	});

	test("fails fast when the session has no decision yet", async () => {
		const { service } = createService({ seekArmed: false });

		await expect(service.get("session-1", SEGMENT)).rejects.toMatchObject({ category: "timeout", code: "stream.not_ready" });
	});

	test("rejects segments during an ongoing seek without implicit seek", async () => {
		const { service, calls } = createService({ seeking: true });

		await expect(service.get("session-1", SEGMENT)).rejects.toMatchObject({ category: "not_found", code: "stream.segment_not_found" });
		expect(calls.seekTo).toEqual([]);
	});
});
