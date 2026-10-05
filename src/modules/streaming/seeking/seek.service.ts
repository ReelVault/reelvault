import type { StreamSeekResponse } from "@reelvault/sdk/common";
import { BaseService } from "@/utils/base-service";
import { RequestTimeoutError } from "@/utils/errors";
import { isFiniteNumber } from "@/utils/type.utils";
import { defaultFindForStreamingDuration, defaultRequireSession } from "../contracts";
import { streamingManager as streamingRuntimeService } from "../runtime/streaming.manager";
import type { RequireSession } from "../streaming.types";
import { clampSeekOffsetToDuration } from "../utils/playback-budgets";

interface ServiceDependencies {
	requireSession: RequireSession;
	findForStreamingDuration: (fileId: string) => Promise<{ duration: number | null } | undefined>;
	getSessionDecision: typeof streamingRuntimeService.getSessionDecision;
	seekTo: typeof streamingRuntimeService.seekTo;
}

const defaultDependencies: ServiceDependencies = {
	requireSession: defaultRequireSession,
	findForStreamingDuration: defaultFindForStreamingDuration,
	getSessionDecision: (sessionId) => streamingRuntimeService.getSessionDecision(sessionId),
	seekTo: (sessionId, position, decision) => streamingRuntimeService.seekTo(sessionId, position, decision),
};

export class SeekService extends BaseService {
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SeekService");
		this.dependencies = dependencies;
	}

	async seek(sessionId: string, requestedPosition: number | null | undefined): Promise<StreamSeekResponse> {
		const { requireSession, findForStreamingDuration, getSessionDecision, seekTo } = this.dependencies;
		const access = requireSession(sessionId);
		const file = await findForStreamingDuration(access.mediaFileId);
		this.assertExists(file, "Streaming", access.mediaFileId);

		const rawPosition = isFiniteNumber(requestedPosition) ? requestedPosition : 0;
		const duration = file.duration ?? null;
		// SessionSeeker owns the seek-offset clamp; this only reports the clamped
		// position back to the client (route contract: [0, duration - EOF guard]).
		const position = clampSeekOffsetToDuration(rawPosition, duration);
		const decision = getSessionDecision(sessionId);
		if (!decision) throw new RequestTimeoutError("Streaming session is not ready yet. Try again in a moment.");

		const { startTime, reusedBuffer } = await seekTo(sessionId, rawPosition, decision);

		return { position, startTime, reusedBuffer };
	}
}

export const seekService = new SeekService();
