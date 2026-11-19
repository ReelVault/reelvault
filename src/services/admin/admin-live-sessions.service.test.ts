import { afterEach, describe, expect, test } from "bun:test";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { DomainError } from "@/utils/domain.errors";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminLiveSessionsService } from "./admin-live-sessions.service";

useTestDatabase();

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("AdminLiveSessionsService.terminateSessions", () => {
	test("terminates each session on its own and reports one outcome per session", async () => {
		// Live sessions are FFmpeg-backed process state: the streaming manager's access lookup and teardown are stubbed at that boundary.
		stubs.push(
			stubMethod(streamingManager, "getSessionAccess", () => ({ mediaFileId: "media-1", profileId: undefined })),
			stubMethod(streamingManager, "releaseSession", (sessionId: string) => {
				if (sessionId === "s-2") return Promise.reject(new DomainError("conflict", "Session is busy", { code: "stream.session_busy" }));

				return Promise.resolve("released");
			}),
		);

		const result = await adminLiveSessionsService.terminateSessions({ sessionIds: ["s-1", "s-2", "s-1", "s-3"], reason: "maintenance" });

		expect(result).toEqual({
			terminated: 2,
			failed: 1,
			results: [
				{ sessionId: "s-1", success: true },
				{ sessionId: "s-2", success: false, errorCode: "stream.session_busy" },
				{ sessionId: "s-3", success: true },
			],
		});
	});
});
