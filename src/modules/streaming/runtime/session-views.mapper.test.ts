import { describe, expect, test } from "bun:test";
import { SOFTWARE_HWACCEL } from "@/integrations/ffmpeg/capabilities/hwaccel.utils";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { SessionStore } from "./session-state/session.store";
import { buildSessionDiagnostics } from "./session-views.mapper";

function createSession() {
	const store = new SessionStore();

	return store.register({
		id: "s1",
		mediaFileId: "file-1",
		profileId: "profile-1",
		decision: createMockPlaybackDecision(),
		inputPath: "/media/f.mkv",
		tempDir: "/tmp/s1",
	});
}

describe("session diagnostics view", () => {
	test("reports encode seconds to two decimals and tonemapping as negotiated", () => {
		const session = createSession();
		session.transcodePositionMs = 12_345;
		session.transcodePercent = 42;
		session.transcodeSpeed = "3.1x";

		const diagnostics = buildSessionDiagnostics(session, { hwaccel: SOFTWARE_HWACCEL, toneMapMethod: "none" });

		expect(diagnostics).toMatchObject({
			encodePositionSeconds: 12.35,
			encodePercent: 42,
			encodeSpeed: "3.1x",
			tonemapped: false,
			toneMapMethod: "none",
		});
	});
});
