import { describe, expect, test } from "bun:test";
import type { HlsBufferAnalysis } from "../streaming.types";
import { DiagnosticsService, type ServiceDependencies } from "./diagnostics.service";

function createService(
	options: {
		bufferComplete?: boolean | undefined;
		sessionActive?: boolean | undefined;
		sessionDiagnostics?: ReturnType<ServiceDependencies["getSessionDiagnostics"]>;
		buffer?: Record<string, unknown> | null | undefined;
		duration?: number | null | undefined;
	} = {},
) {
	const file = {
		id: "file-1",
		fileName: "movie.mkv",
		formatName: "matroska",
		size: 1_000_000,
		duration: options.duration === undefined ? 600 : options.duration,
		bitRate: 5_000_000,
		videoStreams: [
			{
				index: 0,
				isDefault: true,
				codecName: "h264",
				width: 1920,
				height: 1080,
				profile: "high",
				pixelFormat: "yuv420p",
				frameRate: "24/1",
			},
		],
		audioStreams: [
			{
				index: 1,
				isDefault: true,
				codecName: "aac",
				channels: 2,
				channelLayout: "stereo",
				language: "pol",
				title: "Polski",
				bitRate: 192000,
			},
			{ index: 2, isDefault: false, codecName: "ac3", channels: 6, language: "eng" },
		],
	};
	const buffer: HlsBufferAnalysis | null =
		options.buffer === null
			? null
			: {
					complete: options.bufferComplete ?? false,
					bufferedSeconds: 42.45,
					bufferedUntil: 120.44,
					segments: [
						{ index: 0, startTime: 0, endTime: 4, duration: 4 },
						{ index: 1, startTime: 4, endTime: 8, duration: 4 },
						{ index: 2, startTime: 8, endTime: 12, duration: 4 },
					],
					ranges: [],
				};
	const dependencies: ServiceDependencies = {
		requireSession: () => ({ mediaFileId: "file-1", profileId: "profile-1" }),
		findForStreamingDiagnostics: async () => file,
		findForStreamingDuration: async () => ({ id: "file-1", duration: file.duration }),
		getBuffer: async () => buffer,
		getSessionDiagnostics: () =>
			options.sessionDiagnostics === undefined
				? {
						operationId: undefined,
						mode: "transcode",
						videoTranscode: true,
						audioTranscode: false,
						videoEncoder: "libx264",
						audioEncoder: "copy",
						tonemapped: false,
						toneMapMethod: "none",
						reasons: { video: { code: "codec" }, audio: { code: "direct" } },
						targetVideoBitrateKbps: 8000,
						hwaccel: "none",
						reason: "codec",
						audioStreamIndex: 2,
						startTime: 30,
						startedAt: "2026-09-10T00:00:00.000Z",
						lastActivityAt: "2026-09-10T00:01:00.000Z",
						processId: 1234,
						processExitCode: null,
						encodePositionSeconds: 30,
						encodePercent: 25,
						encodeSpeed: "4.2x",
					}
				: options.sessionDiagnostics,
		isSessionActive: () => options.sessionActive ?? true,
		segmentDurationSeconds: 4,
	};

	return { service: new DiagnosticsService(dependencies), file };
}

describe("diagnostics service", () => {
	test("maps the source, session and buffer into a diagnostics response", async () => {
		const { service } = createService();

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.mediaFileId).toBe("file-1");
		expect(diagnostics.source).toMatchObject({
			container: "matroska",
			bitrateKbps: 5000,
			videoCodec: "h264",
			width: 1920,
			height: 1080,
			aspectRatio: "1920:1080",
			audioStreamIndex: 2,
			audioCodec: "ac3",
			audioLanguage: "eng",
			audioTitle: null,
		});
		expect(diagnostics.session).toMatchObject({ mode: "transcode", videoEncoder: "libx264", hwaccel: "none" });
		expect(diagnostics.buffer).toMatchObject({
			state: "transcoding",
			active: true,
			bufferedSeconds: 42.45,
			bufferedUntil: 120.44,
			segments: 3,
			segmentDuration: 4,
		});
	});

	test("completed buffer reports a completed state", async () => {
		const { service } = createService({ bufferComplete: true, sessionActive: false });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.buffer?.state).toBe("completed");
		expect(diagnostics.buffer?.active).toBe(false);
	});

	test("missing session diagnostics yield a null session and default audio stream", async () => {
		const { service } = createService({ sessionDiagnostics: null, sessionActive: false });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.session).toBeNull();
		expect(diagnostics.buffer?.state).toBe("pending");
		expect(diagnostics.source.audioStreamIndex).toBe(1);
		expect(diagnostics.source.audioTitle).toBe("Polski");
	});

	test("a missing buffer analysis reports no buffer section", async () => {
		const { service } = createService({ buffer: null });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.buffer).toBeNull();
	});

	test("getTranscodeProgress reports transcoding vs completed state", async () => {
		const { service } = createService({ bufferComplete: true });
		const progress = await service.getTranscodeProgress("s1");

		expect(progress).toMatchObject({
			sessionId: "s1",
			mediaFileId: "file-1",
			state: "completed",
			active: true,
			segments: 3,
			transcodedSeconds: 42.45,
			transcodedUntil: 120.44,
			duration: 600,
			remainingSeconds: 479.56,
		});

		const pending = await service.getTranscodeProgress("s1");
		expect(pending.mediaFileId).toBe("file-1");
	});

	test("transcode progress handles an unknown duration", async () => {
		const { service } = createService({ duration: null });

		const progress = await service.getTranscodeProgress("s1");

		expect(progress.remainingSeconds).toBeNull();
		expect(progress.progressPercent).toBeNull();
	});
});
