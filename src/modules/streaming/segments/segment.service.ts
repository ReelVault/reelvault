import type { PlaybackDecision } from "@sdk/common/stream.types";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { NotFoundError, RequestTimeoutError, ValidationError } from "@/utils/errors";
import { defaultRequireSession } from "../contracts";
import { streamingService as streamingRuntimeService } from "../runtime/streaming.manager";
import type { SeekResult } from "../streaming.types";
import { ImplicitSeekCoordinator } from "./implicit-seek.coordinator";
import { SegmentLookup, type SegmentWaitContext } from "./segment-lookup";

const SAFE_SEGMENT_PATTERN = /^(init\.mp4|seg_\d+\.m4s)$/;

function assertSafeSegment(segment: string): void {
	if (!SAFE_SEGMENT_PATTERN.test(segment)) {
		throw new ValidationError("Invalid segment name");
	}
}

export interface SegmentServiceRuntime {
	keepAlive(sessionId: string): void;
	beginSegment(sessionId: string): void;
	endSegment(sessionId: string): void;
	getSessionStartTime(sessionId: string): number | undefined;
	getSegmentInfo(segment: string): { startTime: number; index: number } | null;
	getFilePath(sessionId: string, segment: string): string;
	isSessionSeeking(sessionId: string): boolean;
	getSessionDecision(sessionId: string): PlaybackDecision | undefined;
	seekTo(sessionId: string, position: number, decision: PlaybackDecision): Promise<SeekResult> | SeekResult;
}

export interface SegmentServiceLookup {
	find(context: SegmentWaitContext): Promise<Blob | undefined> | Blob | undefined;
	readAfterSeek(context: SegmentWaitContext, timeoutMs: number): Promise<Blob>;
}

export interface SegmentServiceImplicitSeek {
	tryBegin(sessionId: string): boolean;
	announceSeeked(params: { sessionId: string; startTime: number; position: number }): void;
}

export interface ServiceDependencies {
	requireSession: (sessionId: string, label?: string) => unknown;
	runtime: SegmentServiceRuntime;
	lookup: SegmentServiceLookup;
	implicitSeek: SegmentServiceImplicitSeek;
	recoveryTimeoutMs?: number;
}

const defaultDependencies: ServiceDependencies = {
	requireSession: defaultRequireSession,
	runtime: streamingRuntimeService,
	lookup: new SegmentLookup(),
	implicitSeek: new ImplicitSeekCoordinator(),
};

export class SegmentService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SegmentService");
		this.dependencies = dependencies;
	}

	async get(sessionId: string, segment: string, signal?: AbortSignal): Promise<Blob> {
		assertSafeSegment(segment);
		this.dependencies.requireSession(sessionId);
		const runtime = this.dependencies.runtime;
		runtime.keepAlive(sessionId);
		// A long segment wait must not let the inactivity reaper expire the session.
		runtime.beginSegment(sessionId);

		try {
			const segmentDuration = serverConfig.stream.hlsSegmentDurationSeconds;
			const sessionStartTime = runtime.getSessionStartTime(sessionId);
			const segmentInfo = segment !== "init.mp4" ? runtime.getSegmentInfo(segment) : null;

			if (segmentInfo && sessionStartTime !== undefined && segmentInfo.startTime < sessionStartTime) {
				throw new NotFoundError(`Obsolete segment requested: ${segment}`);
			}

			const context: SegmentWaitContext = {
				segment,
				filePath: runtime.getFilePath(sessionId, segment),
				signal,
				isSeeking: () => runtime.isSessionSeeking(sessionId),
				isNearActiveWindow:
					!!segmentInfo && sessionStartTime !== undefined && segmentInfo.startTime <= sessionStartTime + segmentDuration * 2,
			};

			const existing = await this.dependencies.lookup.find(context);
			if (existing) return existing;

			this.logger.warn(`Segment missing ahead, triggering fast seek: ${segment}`, { sessionId });

			if (!this.dependencies.implicitSeek.tryBegin(sessionId)) {
				throw new NotFoundError(`Segment not found (implicit seek cooldown): ${segment}`);
			}

			const decision = runtime.getSessionDecision(sessionId);
			if (!decision) throw new RequestTimeoutError("Streaming session is not ready yet. Try again in a moment.");

			const seekResult = await runtime.seekTo(sessionId, segmentInfo?.startTime ?? 0, decision);
			this.dependencies.implicitSeek.announceSeeked({
				sessionId,
				startTime: seekResult.startTime,
				position: segmentInfo?.startTime ?? 0,
			});

			const recoveryTimeoutMs = this.dependencies.recoveryTimeoutMs ?? serverConfig.stream.recoverySegmentTimeoutMs;

			return await this.dependencies.lookup.readAfterSeek(context, recoveryTimeoutMs);
		} finally {
			runtime.endSegment(sessionId);
		}
	}
}

export const segmentService = new SegmentService();
