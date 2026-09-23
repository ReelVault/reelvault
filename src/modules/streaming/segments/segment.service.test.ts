import { describe, expect, test } from "bun:test";
import { file } from "bun";
import { NotFoundError } from "@/utils/errors";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { SegmentService, type ServiceDependencies } from "./segment.service";

function createService(
	options: {
		existing?: boolean | undefined;
		waitOutcome?: "ok" | "timeout" | undefined;
		seeking?: boolean | undefined;
		nearWindow?: boolean | undefined;
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
		getFilePath: (_sessionId: string, segment: string) => `/tmp/session-1/${segment}`,
		isSessionSeeking: () => options.seeking ?? false,
		getSessionDecision: () => (options.seekArmed === false ? undefined : createMockPlaybackDecision({ mode: "transcode" })),
		seekTo: (sessionId: string, startTime: number) => {
			calls.seekTo.push({ sessionId, startTime });

			return { startTime, reusedBuffer: false };
		},
	};

	const lookup = {
		find: (context: { isSeeking: () => boolean }) => {
			if (options.existing) return file("/dev/null");

			// A real SegmentLookup breaks the wait-ladder with an error when the session is seeking.
			if (context.isSeeking()) throw new NotFoundError("Segment not found after ongoing seek");

			if (options.waitOutcome === "ok") return file("/dev/null");

			return undefined;
		},
		readAfterSeek: async () => file("/dev/null"),
	};

	const implicitSeek = {
		tryBegin: () => true,
		invalidate: () => {
			/* intentionally empty */
		},
		announceSeeked: (announcement: { sessionId: string; startTime: number; position: number }) => {
			calls.broadcasts.push({ event: "playback:session:seeked", payload: announcement });
		},
	};

	const dependencies: ServiceDependencies = {
		requireSession: (sessionId) => {
			calls.requireSession.push(sessionId);
		},
		runtime,
		lookup,
		implicitSeek,
	};

	return { service: new SegmentService(dependencies), calls };
}

describe("segment service", () => {
	test("serves an existing segment after keeping the session alive", async () => {
		const { service, calls } = createService({ existing: true });

		const result = await service.get("session-1", "seg_5.m4s");

		expect(result).toBeDefined();
		expect(calls.keepAlive).toEqual(["session-1"]);
		expect(calls.requireSession).toEqual(["session-1"]);
		expect(calls.seekTo).toEqual([]);
	});

	test("rejects obsolete segments from before the session start", async () => {
		const { service } = createService({ existing: false, obsolete: true });

		await expect(service.get("session-1", "seg_5.m4s")).rejects.toThrow("Obsolete segment");
	});

	test("rejects invalid segment names before touching the session", async () => {
		const { service, calls } = createService();

		await expect(service.get("session-1", "../escape.m4s")).rejects.toThrow("Invalid segment name");
		expect(calls.requireSession).toEqual([]);
	});

	test("triggers an implicit seek for far-future segments and announces it", async () => {
		const { service, calls } = createService({ existing: false, waitOutcome: "timeout" });

		const result = await service.get("session-1", "seg_5.m4s");

		expect(result).toBeDefined();
		expect(calls.seekTo).toEqual([{ sessionId: "session-1", startTime: 60 }]);
		expect(calls.broadcasts[0]?.event).toBe("playback:session:seeked");
		expect(calls.broadcasts[0]?.payload).toMatchObject({ sessionId: "session-1", position: 60 });
	});

	test("fails fast when the session has no decision yet", async () => {
		const { service } = createService({ existing: false, waitOutcome: "timeout", seekArmed: false });

		await expect(service.get("session-1", "seg_5.m4s")).rejects.toThrow("not ready yet");
	});

	test("rejects segments during an ongoing seek without implicit seek", async () => {
		const { service, calls } = createService({ seeking: true });

		// lookup.find ends with NotFoundError before the service reaches for an implicit seek.
		await expect(service.get("session-1", "seg_5.m4s")).rejects.toThrow("after ongoing seek");
		expect(calls.seekTo).toEqual([]);
	});
});
