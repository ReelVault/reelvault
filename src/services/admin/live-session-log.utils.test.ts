import { describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync } from "fflate";
import {
	buildSessionLogArchive,
	isSessionOperationLog,
	sessionLogArchiveName,
	sessionLogSegments,
	summarizeFfmpegLog,
} from "./live-session-log.utils";

const LOG_TEXT = [
	"=== FFmpeg operation started ===",
	"operationId: sess-1",
	"mode: transcode",
	"input: /media/a.mkv",
	"output: /tmp/out.m3u8",
	"command: 'ffmpeg' '-i' '/media/a.mkv'",
	"startedAt: 2026-10-09T18:01:51.000Z",
	"processId: 4242",
	"[stderr] frame=1 error: not a failure of the run",
	"[progress] out_time=00:00:02",
	"exitCode: 1",
	"signalCode: null",
	"finishedAt: 2026-10-09T18:02:10.000Z",
	"durationMs: 19000",
	"error: ffmpeg exited with status 1",
	"=== FFmpeg operation finished ===",
].join("\n");

describe("isSessionOperationLog", () => {
	test("matches the operation id that follows the start time", () => {
		expect(isSessionOperationLog("FFmpeg.Transcode-2026-10-09_18-01-51_sess-1.log", ["sess-1"])).toBe(true);
	});

	test("does not match an id that only ends the same way", () => {
		expect(isSessionOperationLog("FFmpeg.Transcode-2026-10-09_18-01-51_other_sess-1.log", ["sess-1"])).toBe(false);
	});

	test("ignores files that are not operation logs", () => {
		expect(isSessionOperationLog("reelvault-2026-10-09.log", ["reelvault-2026-10-09"])).toBe(false);
	});
});

describe("summarizeFfmpegLog", () => {
	test("summarizes one run from its header and footer lines", () => {
		expect(summarizeFfmpegLog("2026-10-09/run.log", LOG_TEXT)).toEqual({
			file: "2026-10-09/run.log",
			mode: "transcode",
			startedAt: "2026-10-09T18:01:51.000Z",
			finishedAt: "2026-10-09T18:02:10.000Z",
			durationMs: 19000,
			processId: 4242,
			exitCode: "1",
			signalCode: null,
			error: "ffmpeg exited with status 1",
		});
	});
});

describe("buildSessionLogArchive", () => {
	test("zips the logs with a timeline ordered by start time", async () => {
		const later = LOG_TEXT.replace("2026-10-09T18:01:51.000Z", "2026-10-09T19:00:00.000Z");
		const archive = await buildSessionLogArchive(
			"sess-1",
			[
				{ name: "2026-10-09/later.log", bytes: strToU8(later) },
				{ name: "2026-10-09/first.log", bytes: strToU8(LOG_TEXT) },
			],
			true,
		);

		const entries = unzipSync(archive);
		expect(Object.keys(entries).toSorted()).toEqual(["ffmpeg/2026-10-09/first.log", "ffmpeg/2026-10-09/later.log", "timeline.json"]);
		expect(strFromU8(entries["ffmpeg/2026-10-09/first.log"] ?? new Uint8Array())).toBe(LOG_TEXT);

		const timeline = JSON.parse(strFromU8(entries["timeline.json"] ?? new Uint8Array()));
		expect(timeline).toMatchObject({ sessionId: "sess-1", truncated: true });
		expect(timeline.runs.map((run: { file: string }) => run.file)).toEqual(["2026-10-09/first.log", "2026-10-09/later.log"]);
	});
});

describe("session log names", () => {
	test("keeps only the characters a log name keeps in the archive name", () => {
		expect(sessionLogArchiveName("sess/1", new Date("2026-10-09T18:01:51.000Z"))).toBe(
			"reelvault-session-sess_1-2026-10-09T18-01-51-000Z.zip",
		);
	});

	test("names a session's logs after its id and, once attached, its operation id", () => {
		expect(sessionLogSegments("sess-1", "op.2")).toEqual(["sess-1", "op_2"]);
		expect(sessionLogSegments("sess-1", undefined)).toEqual(["sess-1"]);
	});
});
