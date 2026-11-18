import { afterEach, describe, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { assertNoActiveStreamsForMediaFileIds } from "./active-streams.guard";

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("assertNoActiveStreamsForMediaFileIds single-file path", () => {
	test("refuses a single streamed file and reports one active stream", () => {
		stubs.push(stubMethod(streamingManager, "getActiveMediaFileIds", () => new Set(["file-1"])));

		expect(() =>
			assertNoActiveStreamsForMediaFileIds("file-1", {
				message: "Delete is blocked while a stream is playing this file",
				code: "media.delete_blocked_active_streams",
			}),
		).toThrow(
			expect.objectContaining({
				category: "conflict",
				code: "media.delete_blocked_active_streams",
				params: { activeStreams: 1 },
			}),
		);
	});
});
