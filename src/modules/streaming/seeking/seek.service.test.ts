import { describe, expect, test } from "bun:test";
import { createMockPlaybackDecision } from "../streaming.test-utils";
import { SeekService } from "./seek.service";

function createService(options: { duration?: number | null; hasDecision?: boolean; seekStart?: number } = {}) {
	const seekCalls: Array<{ sessionId: string; position: number }> = [];
	const service = new SeekService({
		requireSession: () => ({ mediaFileId: "file-1", profileId: "profile-1" }),
		findForStreamingDuration: async () => ({ duration: options.duration ?? 600 }),
		getSessionDecision: () => (options.hasDecision === false ? undefined : createMockPlaybackDecision({ mode: "transcode" })),
		seekTo: (sessionId: string, position: number) => {
			seekCalls.push({ sessionId, position });

			return Promise.resolve({ startTime: options.seekStart ?? position, reusedBuffer: false });
		},
	});

	return { service, seekCalls };
}

describe("seek service", () => {
	test("executes a seek at the requested position", async () => {
		const { service, seekCalls } = createService();

		const result = await service.seek("s1", 120);

		expect(result).toEqual({ position: 120, startTime: 120, reusedBuffer: false });
		expect(seekCalls).toEqual([{ sessionId: "s1", position: 120 }]);
	});

	test("collapses missing and non-finite positions to 0", async () => {
		const { service, seekCalls } = createService();

		expect((await service.seek("s1", null)).position).toBe(0);
		expect((await service.seek("s1", Number.NaN)).position).toBe(0);
		expect((await service.seek("s1", Number.POSITIVE_INFINITY)).position).toBe(0);
		expect(seekCalls.every((call) => call.position === 0)).toBe(true);
	});

	test("clamps the position before the EOF guard", async () => {
		const { service, seekCalls } = createService({ duration: 600 });

		const result = await service.seek("s1", 599.5);

		// EOF guard = 1s: the maximum position is 599.
		expect(result.position).toBe(599);
		expect(seekCalls[0]?.position).toBe(599);
	});

	test("keeps the raw position when the duration is unknown", async () => {
		const { service } = createService({ duration: null });

		expect((await service.seek("s1", 42)).position).toBe(42);
	});

	test("rejects negative positions to zero", async () => {
		const { service, seekCalls } = createService();

		expect((await service.seek("s1", -10)).position).toBe(0);
		expect(seekCalls[0]?.position).toBe(0);
	});

	test("fails when the session has no decision yet", () => {
		const { service } = createService({ hasDecision: false });

		expect(service.seek("s1", 10)).rejects.toThrow("not ready yet");
	});
});
