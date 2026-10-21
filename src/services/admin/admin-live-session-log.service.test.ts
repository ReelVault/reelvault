import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { serverConfig } from "@/config/server/server.config";
import { operationLogSegment } from "@/integrations/ffmpeg/ffmpeg.operation-log";
import { endedSessionHistory } from "@/modules/streaming/runtime/ended-session.history";
import { removeTreeSync } from "@/utils/directory.utils";
import { adminLiveSessionsService } from "./admin-live-sessions.service";

/**
 * The log archive of a session works for a live session and for one that has already ended.
 * An ended session is no longer active, so its FFmpeg logs are found through the operation
 * recorded in its history entry; a session that is in neither place is refused with its code.
 */

const ARCHIVE_NAME = /^reelvault-session-.+\.zip$/;
const LOG_TEXT = ["=== FFmpeg operation started ===", "operationId: op-ended", "exitCode: 0", "=== FFmpeg operation finished ==="].join(
	"\n",
);

describe("AdminLiveSessionsService.getSessionLog for an ended session", () => {
	test("the archive holds the operation logs of the ended session and a timeline", async () => {
		const sessionId = `ended-${crypto.randomUUID()}`;
		const operationId = `op-${crypto.randomUUID()}`;
		const dayFolder = `test-${crypto.randomUUID()}`;
		const logPath = `ffmpeg/${dayFolder}/FFmpeg.Transcode-2026-10-10_12-00-00_${operationLogSegment(operationId)}.log`;
		const dayDirectory = join(serverConfig.paths.logs, "ffmpeg", dayFolder);
		mkdirSync(dayDirectory, { recursive: true });
		writeFileSync(join(serverConfig.paths.logs, logPath), LOG_TEXT);
		endedSessionHistory.record({
			sessionId,
			mediaFileId: "media-ended",
			profileId: "profile-ended",
			reason: "inactivity-timeout",
			startedAt: Date.now() - 60_000,
			endedAt: Date.now(),
			operationId,
		});

		try {
			const { data, filename } = await adminLiveSessionsService.getSessionLog(sessionId);
			const entries = unzipSync(data);

			expect(filename).toMatch(ARCHIVE_NAME);
			expect(Object.keys(entries).toSorted()).toEqual([logPath, "timeline.json"].toSorted());
			expect(new TextDecoder().decode(entries[logPath] ?? new Uint8Array())).toBe(LOG_TEXT);
		} finally {
			removeTreeSync(dayDirectory);
		}
	});

	test("a session that is neither live nor in the history is refused with its code", async () => {
		const missing = `missing-${crypto.randomUUID()}`;

		await expect(adminLiveSessionsService.getSessionLog(missing)).rejects.toMatchObject({ code: "stream.session_not_found" });
	});
});
