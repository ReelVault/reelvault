import type { StreamSeekResponse } from "@reelvault/sdk/common";
import { BaseService } from "@/utils/base-service";
import { RequestTimeoutError } from "@/utils/errors";
import { clamp } from "@/utils/math.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import { defaultFindForStreamingDuration, defaultRequireSession } from "../contracts";
import { streamingService as streamingRuntimeService } from "../runtime/streaming.manager";
import type { RequireSession } from "../streaming.types";
import { SEEK_EOF_GUARD_SECONDS } from "../utils/playback-budgets";

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
		const position =
			duration && duration > 0 ? clamp(rawPosition, 0, Math.max(0, duration - SEEK_EOF_GUARD_SECONDS)) : Math.max(0, rawPosition);
		const decision = getSessionDecision(sessionId);
		if (!decision) throw new RequestTimeoutError("Streaming session is not ready yet. Try again in a moment.");

		const { startTime, reusedBuffer } = await seekTo(sessionId, position, decision);

		return { position, startTime, reusedBuffer };
	}
}

export const seekService = new SeekService();
