import type { PlaybackDiagnostics, TranscodeProgressResponse } from "@reelvault/sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { calculateBufferProgress } from "../buffer/hls-buffer";
import { defaultFindForStreamingDuration, defaultRequireSession } from "../contracts";
import { selectDefaultOrFirstStream } from "../decisions/stream-preferences";
import { streamingManager as streamingRuntimeService } from "../runtime/streaming.manager";
import type { HlsBufferAnalysis, RequireSession } from "../streaming.types";

export interface DiagnosticsMediaFile {
	id: string;
	fileName?: string | null | undefined;
	formatName?: string | null | undefined;
	size?: number | null | undefined;
	duration?: number | null | undefined;
	bitRate?: number | null | undefined;
	videoStreams?:
		| Array<{
				index: number;
				isDefault: boolean;
				codecName?: string | null | undefined;
				profile?: string | null | undefined;
				width?: number | null | undefined;
				height?: number | null | undefined;
				frameRate?: string | null | undefined;
				pixelFormat?: string | null | undefined;
		  }>
		| undefined;
	audioStreams?:
		| Array<{
				index: number;
				isDefault: boolean;
				codecName?: string | null | undefined;
				channels?: number | null | undefined;
				channelLayout?: string | null | undefined;
				language?: string | null | undefined;
				title?: string | null | undefined;
				bitRate?: number | null | undefined;
		  }>
		| undefined;
}

export interface ServiceDependencies {
	requireSession: RequireSession;
	findForStreamingDiagnostics: (fileId: string) => Promise<DiagnosticsMediaFile | null | undefined>;
	findForStreamingDuration: (fileId: string) => Promise<{ id: string; duration: number | null } | null | undefined>;
	getBuffer: (sessionId: string) => Promise<HlsBufferAnalysis | null>;
	getSessionDiagnostics: (sessionId: string) => ReturnType<typeof streamingRuntimeService.getDiagnostics>;
	isSessionActive: (sessionId: string) => boolean;
	segmentDurationSeconds: number;
}

type BufferState = "completed" | "transcoding" | "pending";

interface BufferProgress {
	state: BufferState;
	active: boolean;
	transcodedSeconds: number;
	transcodedUntil: number;
	remainingSeconds: number | null;
	progressPercent: number | null;
}

function resolveBufferState(complete: boolean, active: boolean): BufferState {
	if (complete) return "completed";

	return active ? "transcoding" : "pending";
}

function round2(value: number): number {
	return Number(value.toFixed(2));
}

/** Shared state + progress projection for the diagnostics and transcode-progress responses. */
function toBufferProgress(analysis: HlsBufferAnalysis, active: boolean, duration: number | null): BufferProgress {
	const transcodedUntil = round2(analysis.bufferedUntil);

	return {
		state: resolveBufferState(analysis.complete, active),
		active,
		transcodedSeconds: round2(analysis.bufferedSeconds),
		transcodedUntil,
		remainingSeconds: duration !== null ? Math.max(0, round2(duration - transcodedUntil)) : null,
		progressPercent: calculateBufferProgress(transcodedUntil, duration),
	};
}

const defaultDependencies: ServiceDependencies = {
	requireSession: defaultRequireSession,
	findForStreamingDiagnostics: (fileId) => mediaRepository.findForStreamingDiagnostics(fileId),
	findForStreamingDuration: defaultFindForStreamingDuration,
	getBuffer: async (sessionId) => await streamingRuntimeService.getBuffer(sessionId).catch(() => null),
	getSessionDiagnostics: (sessionId) => streamingRuntimeService.getDiagnostics(sessionId),
	isSessionActive: (sessionId) => streamingRuntimeService.isSessionActive(sessionId),
	segmentDurationSeconds: serverConfig.stream.hlsSegmentDurationSeconds,
};

export class DiagnosticsService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("DiagnosticsService");
		this.dependencies = dependencies;
	}

	async getDiagnostics(sessionId: string): Promise<PlaybackDiagnostics> {
		const { requireSession, findForStreamingDiagnostics, getBuffer, getSessionDiagnostics, isSessionActive, segmentDurationSeconds } =
			this.dependencies;
		const access = requireSession(sessionId);
		const [file, bufferAnalysis] = await Promise.all([findForStreamingDiagnostics(access.mediaFileId), getBuffer(sessionId)]);
		this.assertExists(file, "MediaFile", access.mediaFileId);

		const sessionDiag = getSessionDiagnostics(sessionId);
		const defaultVideoStream = selectDefaultOrFirstStream(file.videoStreams ?? []);

		const selectedAudioIndex = sessionDiag?.audioStreamIndex;
		const audioStreams = file.audioStreams ?? [];
		let targetAudioStream = selectDefaultOrFirstStream(audioStreams);
		if (selectedAudioIndex != null) {
			targetAudioStream = audioStreams.find((s) => s.index === selectedAudioIndex) ?? targetAudioStream;
		}

		const active = isSessionActive(sessionId);
		const duration = file.duration ?? null;
		const bufferProgress = bufferAnalysis ? toBufferProgress(bufferAnalysis, active, duration) : null;

		return {
			mediaFileId: file.id,
			source: {
				container: file.formatName ?? file.fileName?.split(".").pop() ?? null,
				sizeBytes: file.size ?? null,
				duration: file.duration ?? null,
				bitrateKbps: file.bitRate ? Math.round(file.bitRate / 1000) : null,
				videoCodec: defaultVideoStream?.codecName ?? null,
				videoProfile: defaultVideoStream?.profile ?? null,
				width: defaultVideoStream?.width ?? null,
				height: defaultVideoStream?.height ?? null,
				aspectRatio: defaultVideoStream ? `${defaultVideoStream.width ?? "?"}:${defaultVideoStream.height ?? "?"}` : null,
				frameRate: defaultVideoStream?.frameRate ?? null,
				pixelFormat: defaultVideoStream?.pixelFormat ?? null,
				audioStreamIndex: targetAudioStream?.index ?? null,
				audioCodec: targetAudioStream?.codecName ?? null,
				audioChannels: targetAudioStream?.channels ?? null,
				audioChannelLayout: targetAudioStream?.channelLayout ?? null,
				audioLanguage: targetAudioStream?.language ?? null,
				audioTitle: targetAudioStream?.title ?? null,
				audioBitrateKbps: targetAudioStream?.bitRate ? Math.round(targetAudioStream.bitRate / 1000) : null,
			},
			session: sessionDiag
				? {
						...(sessionDiag.operationId ? { operationId: sessionDiag.operationId } : {}),
						mode: sessionDiag.mode,
						videoTranscode: sessionDiag.videoTranscode,
						audioTranscode: sessionDiag.audioTranscode,
						videoEncoder: sessionDiag.videoEncoder,
						audioEncoder: sessionDiag.audioEncoder,
						targetVideoBitrateKbps: sessionDiag.targetVideoBitrateKbps,
						hwaccel: sessionDiag.hwaccel,
						tonemapped: sessionDiag.tonemapped,
						toneMapMethod: sessionDiag.toneMapMethod,
						reasons: sessionDiag.reasons,
						startTime: sessionDiag.startTime,
						startedAt: sessionDiag.startedAt,
						lastActivityAt: sessionDiag.lastActivityAt,
						processId: sessionDiag.processId,
						processExitCode: sessionDiag.processExitCode,
						encodePositionSeconds: sessionDiag.encodePositionSeconds,
						encodePercent: sessionDiag.encodePercent,
						encodeSpeed: sessionDiag.encodeSpeed,
					}
				: null,
			buffer:
				bufferAnalysis && bufferProgress
					? {
							state: bufferProgress.state,
							active: bufferProgress.active,
							bufferedSeconds: bufferProgress.transcodedSeconds,
							bufferedUntil: bufferProgress.transcodedUntil,
							segments: bufferAnalysis.segments.length,
							segmentDuration: segmentDurationSeconds,
							progressPercent: bufferProgress.progressPercent,
						}
					: null,
		};
	}

	async getTranscodeProgress(sessionId: string): Promise<TranscodeProgressResponse> {
		const { requireSession, findForStreamingDuration, getBuffer, isSessionActive, segmentDurationSeconds } = this.dependencies;
		const access = requireSession(sessionId);
		const [file, buffer] = await Promise.all([findForStreamingDuration(access.mediaFileId), getBuffer(sessionId)]);
		// No playlist means no progress (the same zeros as analyzing a missing playlist).
		const analysis: HlsBufferAnalysis = buffer ?? { complete: false, segments: [], ranges: [], bufferedSeconds: 0, bufferedUntil: 0 };
		const active = isSessionActive(sessionId);
		const duration = file?.duration ?? null;
		const progress = toBufferProgress(analysis, active, duration);

		return {
			sessionId,
			mediaFileId: access.mediaFileId,
			state: progress.state,
			active: progress.active,
			segmentDuration: segmentDurationSeconds,
			segments: analysis.segments.length,
			transcodedSeconds: progress.transcodedSeconds,
			transcodedUntil: progress.transcodedUntil,
			duration,
			remainingSeconds: progress.remainingSeconds,
			progressPercent: progress.progressPercent,
			ranges: analysis.ranges,
		};
	}
}

export const diagnosticsService = new DiagnosticsService();
