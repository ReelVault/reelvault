import type { StreamSeekResponse } from "@reelvault/sdk/common";
import { defaultFindForStreamingDuration, defaultRequireSession } from "@/modules/streaming/contracts.utils";
import { streamingManager as streamingRuntimeService } from "@/modules/streaming/runtime/streaming.manager";
import type { RequireSession } from "@/modules/streaming/streaming.types";
import { clampSeekOffsetToDuration } from "@/modules/streaming/utils/playback-budgets.utils";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { isFiniteNumber } from "@/utils/type.utils";

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

export class SeekService {
	readonly serviceName = "SeekService";
	readonly logger = createLogger("SeekService");

	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async seek(sessionId: string, requestedPosition: number | null | undefined): Promise<StreamSeekResponse> {
		const { requireSession, findForStreamingDuration, getSessionDecision, seekTo } = this.dependencies;
		const access = requireSession(sessionId);
		const file = await findForStreamingDuration(access.mediaFileId);
		assertFound(file, "Streaming", access.mediaFileId);

		const rawPosition = isFiniteNumber(requestedPosition) ? requestedPosition : 0;
		const duration = file.duration ?? null;
		// SessionSeeker owns the seek-offset clamp; this only reports the clamped
		// position back to the client (route contract: [0, duration - EOF guard]).
		const position = clampSeekOffsetToDuration(rawPosition, duration);
		const decision = getSessionDecision(sessionId);
		if (!decision)
			throw new DomainError("timeout", "Streaming session is not ready yet. Try again in a moment.", {
				code: "stream.not_ready",
			});

		const { startTime, reusedBuffer } = await seekTo(sessionId, rawPosition, decision);

		return { position, startTime, reusedBuffer };
	}
}

export const seekService = new SeekService();
