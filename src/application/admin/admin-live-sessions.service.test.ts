import { afterEach, describe, expect, test } from "bun:test";
import { adminAuditService } from "@/application/admin/admin-audit.service";
import { ConflictError } from "@/utils/errors";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminLiveSessionsService } from "./admin-live-sessions.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("AdminLiveSessionsService.terminateSessions", () => {
	test("terminates each session on its own and reports one outcome per session", async () => {
		const terminate = stubMethod(adminLiveSessionsService, "terminateSession", (sessionId: string) => {
			if (sessionId === "s-2") return Promise.reject(new ConflictError("Session is busy", { code: "stream.session_busy" }));

			return Promise.resolve({ success: true });
		});
		const audit = stubMethod(adminAuditService, "record", () => Promise.resolve());
		stubs.push(terminate, audit);

		const result = await adminLiveSessionsService.terminateSessions({ sessionIds: ["s-1", "s-2", "s-1", "s-3"], reason: "maintenance" });

		expect(terminate.calls).toEqual([
			["s-1", "maintenance"],
			["s-2", "maintenance"],
			["s-3", "maintenance"],
		]);
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
