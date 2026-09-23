import { describe, expect, test } from "bun:test";
import type { PlaybackDecision } from "@reelvault/sdk/common";
import { StreamInitializer, type StreamInitializerDependencies } from "./stream-initializer";

const decision: PlaybackDecision = {
	mode: "direct-stream",
	videoTranscode: false,
	audioTranscode: false,
	reason: "test",
};

function dependencies(overrides: Partial<StreamInitializerDependencies> = {}): StreamInitializerDependencies {
	return {
		hasActiveSession: () => false,
		startSession: async () => undefined,
		discardSession: async () => undefined,
		releaseSessionReservation: () => undefined,
		...overrides,
	};
}

describe("StreamInitializer", () => {
	test("starts a session and always releases its reservation", async () => {
		const calls: string[] = [];
		const initializer = new StreamInitializer(
			dependencies({
				startSession: (_sessionId, _filePath, _decision, startTime, operationId) => {
					calls.push(`start:${startTime}:${operationId}`);

					return Promise.resolve();
				},
				releaseSessionReservation: () => calls.push("release"),
			}),
		);

		const result = await initializer.initialize(
			{ sessionId: "session-1", mediaFileId: "media-1", filePath: "/media/movie.mkv", decision },
			{ correlationId: "operation-1" },
		);

		expect(result).toEqual({ success: true, message: "Session started for session-1" });
		expect(calls).toEqual(["start:0:operation-1", "release"]);
	});

	test("releases the reservation before discarding the session after a start failure", async () => {
		const calls: string[] = [];
		const initializer = new StreamInitializer(
			dependencies({
				startSession: () => Promise.reject(new Error("ffmpeg failed")),
				discardSession: () => {
					calls.push("discard");

					return Promise.resolve();
				},
				releaseSessionReservation: () => calls.push("release"),
			}),
		);

		await expect(
			initializer.initialize({ sessionId: "session-1", mediaFileId: "media-1", filePath: "/media/movie.mkv", decision }, {}),
		).rejects.toThrow("ffmpeg failed");

		// discardSession() no-ops while the reservation is pending — release must run first.
		expect(calls).toEqual(["release", "discard"]);
	});
});
