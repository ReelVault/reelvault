import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { HlsBufferAnalysis } from "@/modules/streaming/streaming.types";
import { mediaRepository } from "@/repositories/media-files.repository";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { DiagnosticsService, type ServiceDependencies } from "./diagnostics.service";

const db = useTestDatabase();

/** One movie file with a video and two audio streams, as the library stores them after a probe. */
async function seedMediaFile(duration: number | null): Promise<string> {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, "/media/movie.mkv", "movie-1");
	await client
		.update(schema.mediaFiles)
		.set({ formatName: "matroska", duration, size: 1_000_000, bitRate: 5_000_000 })
		.where(eq(schema.mediaFiles.id, mediaFileId));
	await client.insert(schema.mediaFileVideoStreams).values({
		mediaFileId,
		index: 0,
		isDefault: true,
		codecName: "h264",
		profile: "high",
		width: 1920,
		height: 1080,
		pixelFormat: "yuv420p",
		frameRate: "24/1",
	});
	await client.insert(schema.mediaFileAudioStreams).values([
		{
			mediaFileId,
			index: 1,
			isDefault: true,
			codecName: "aac",
			channels: 2,
			channelLayout: "stereo",
			language: "pol",
			title: "Polski",
			bitRate: 192000,
		},
		{ mediaFileId, index: 2, isDefault: false, codecName: "ac3", channels: 6, language: "eng" },
	]);

	return mediaFileId;
}

async function createService(
	options: {
		bufferComplete?: boolean | undefined;
		sessionActive?: boolean | undefined;
		sessionDiagnostics?: ReturnType<ServiceDependencies["getSessionDiagnostics"]>;
		buffer?: Record<string, unknown> | null | undefined;
		duration?: number | null | undefined;
	} = {},
) {
	const mediaFileId = await seedMediaFile(options.duration === undefined ? 600 : options.duration);
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
		// The live transcode session (ffmpeg process, playlist, session store) is the process boundary.
		// The library rows behind it are real.
		requireSession: () => ({ mediaFileId, profileId: "profile-1" }),
		findForStreamingDiagnostics: (fileId) => mediaRepository.findForStreamingDiagnostics(fileId),
		findForStreamingDuration: (fileId) => mediaRepository.findForStreamingDuration(fileId),
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
						tonemapped: true,
						toneMapMethod: "zscale",
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

	return { service: new DiagnosticsService(dependencies), mediaFileId };
}

describe("diagnostics service", () => {
	test("maps the source, session and buffer into a diagnostics response", async () => {
		const { service, mediaFileId } = await createService();

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.mediaFileId).toBe(mediaFileId);
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
		expect(diagnostics.session).toMatchObject({
			mode: "transcode",
			videoEncoder: "libx264",
			hwaccel: "none",
			tonemapped: true,
			toneMapMethod: "zscale",
		});
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
		const { service } = await createService({ bufferComplete: true, sessionActive: false });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.buffer?.state).toBe("completed");
		expect(diagnostics.buffer?.active).toBe(false);
	});

	test("missing session diagnostics yield a null session and default audio stream", async () => {
		const { service } = await createService({ sessionDiagnostics: null, sessionActive: false });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.session).toBeNull();
		expect(diagnostics.buffer?.state).toBe("pending");
		expect(diagnostics.source.audioStreamIndex).toBe(1);
		expect(diagnostics.source.audioTitle).toBe("Polski");
	});

	test("a missing buffer analysis reports no buffer section", async () => {
		const { service } = await createService({ buffer: null });

		const diagnostics = await service.getDiagnostics("s1");

		expect(diagnostics.buffer).toBeNull();
	});

	test("transcode progress reports a completed state once the buffer is complete", async () => {
		const { service, mediaFileId } = await createService({ bufferComplete: true });

		const progress = await service.getTranscodeProgress("s1");

		expect(progress).toMatchObject({
			sessionId: "s1",
			mediaFileId,
			state: "completed",
			active: true,
			segments: 3,
			transcodedSeconds: 42.45,
			transcodedUntil: 120.44,
			duration: 600,
			remainingSeconds: 479.56,
		});
	});

	test("transcode progress reports a transcoding state while the buffer is still filling", async () => {
		const { service } = await createService({ bufferComplete: false });

		const progress = await service.getTranscodeProgress("s1");

		expect(progress).toMatchObject({ state: "transcoding", active: true, transcodedUntil: 120.44, remainingSeconds: 479.56 });
	});

	test("transcode progress reports no remaining time or percentage for an unknown duration", async () => {
		const { service } = await createService({ duration: null });

		const progress = await service.getTranscodeProgress("s1");

		expect(progress.remainingSeconds).toBeNull();
		expect(progress.progressPercent).toBeNull();
	});
});
