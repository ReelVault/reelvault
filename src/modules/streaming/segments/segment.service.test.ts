import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { ImplicitSeekCoordinator } from "./implicit-seek.coordinator";
import { SegmentLookup } from "./segment.lookup";
import { SegmentService, type ServiceDependencies } from "./segment.service";

function createService(
	options: {
		existing?: boolean | undefined;
		waitOutcome?: "ok" | "timeout" | undefined;
		seeking?: boolean | undefined;
		seekArmed?: boolean | undefined;
		obsolete?: boolean | undefined;
	} = {},
) {
	const calls = {
		keepAlive: [] as string[],
		seekTo: [] as Array<{ sessionId: string; startTime: number }>,
		broadcasts: [] as Array<{ event: string; payload: unknown }>,
		requireSession: [] as string[],
	};
	const segment = file("/dev/null");
	// The file appears only once the implicit seek has restarted the encode.
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
		getFilePath: (_sessionId: string, name: string) => `/tmp/session-1/${name}`,
		isSessionSeeking: () => options.seeking ?? false,
		getSessionDecision: () => (options.seekArmed === false ? undefined : createMockPlaybackDecision({ mode: "transcode" })),
		seekTo: (sessionId: string, startTime: number) => {
			calls.seekTo.push({ sessionId, startTime });
			seeked = true;

			return { startTime, reusedBuffer: false };
		},
	};

	// The file-system wait is the process boundary. The lookup and the implicit-seek coordinator are real.
	const lookup = new SegmentLookup({
		initialWaitMs: 8_000,
		seekWaitMs: 10_000,
		exists: async () => options.existing ?? false,
		waitForFile: () => {
			if (options.waitOutcome !== "ok" && !seeked) throw new Error("timeout");
		},
		readFile: () => segment,
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

	return { service: new SegmentService(dependencies), calls, segment };
}

describe("segment service", () => {
	test("serves an existing segment after keeping the session alive", async () => {
		const { service, calls, segment } = createService({ existing: true });

		const result = await service.get("session-1", "seg_5.m4s");
		expect(result).toBe(segment);

		expect(calls.keepAlive).toEqual(["session-1"]);
		expect(calls.requireSession).toEqual(["session-1"]);
		expect(calls.seekTo).toEqual([]);
	});

	test("rejects obsolete segments from before the session start", async () => {
		const { service } = createService({ existing: false, obsolete: true });

		await expect(service.get("session-1", "seg_5.m4s")).rejects.toMatchObject({ category: "not_found", code: "stream.segment_obsolete" });
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
		const { service, calls, segment } = createService({ existing: false, waitOutcome: "timeout" });

		const result = await service.get("session-1", "seg_5.m4s");
		expect(result).toBe(segment);

		expect(calls.seekTo).toEqual([{ sessionId: "session-1", startTime: 60 }]);
		expect(calls.broadcasts[0]?.event).toBe("playback:session:seeked");
		expect(calls.broadcasts[0]?.payload).toMatchObject({ sessionId: "session-1", position: 60 });
	});

	test("fails fast when the session has no decision yet", async () => {
		const { service } = createService({ existing: false, waitOutcome: "timeout", seekArmed: false });

		await expect(service.get("session-1", "seg_5.m4s")).rejects.toMatchObject({ category: "timeout", code: "stream.not_ready" });
	});

	test("rejects segments during an ongoing seek without implicit seek", async () => {
		const { service, calls } = createService({ seeking: true });

		await expect(service.get("session-1", "seg_5.m4s")).rejects.toMatchObject({ category: "not_found", code: "stream.segment_not_found" });
		expect(calls.seekTo).toEqual([]);
	});
});
