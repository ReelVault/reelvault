import type { PlaybackDecision } from "@sdk/common/stream.types";
import { type ApplicationContext, toDomainError } from "@/application/context";
import { InternalError } from "@/utils/errors";
import { streamingService } from "./streaming.manager";

export interface StreamInitData {
	sessionId: string;
	mediaFileId: string;
	filePath: string;
	decision: PlaybackDecision;
}

export interface StreamInitResult {
	success: boolean;
	message: string;
}

export interface StreamInitializerDependencies {
	hasActiveSession(sessionId: string): boolean;
	startSession(sessionId: string, filePath: string, decision: PlaybackDecision, startTime: number, operationId?: string): Promise<void>;
	discardSession(sessionId: string): Promise<void>;
	releaseSessionReservation(sessionId: string): void;
}

const defaultDependencies: StreamInitializerDependencies = {
	hasActiveSession: (sessionId) => streamingService.hasActiveSession(sessionId),
	startSession: (sessionId, filePath, decision, startTime, operationId) =>
		streamingService.startSession(sessionId, filePath, decision, startTime, operationId),
	discardSession: (sessionId) => streamingService.discardSession(sessionId),
	releaseSessionReservation: (sessionId) => streamingService.releaseSessionReservation(sessionId),
};

export class StreamInitializer {
	private readonly dependencies: StreamInitializerDependencies;

	constructor(dependencies: StreamInitializerDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async initialize(data: StreamInitData, context: ApplicationContext): Promise<StreamInitResult> {
		try {
			context.signal?.throwIfAborted();
			if (this.dependencies.hasActiveSession(data.sessionId)) {
				context.logger?.debug("Restarting active session", {
					sessionId: data.sessionId,
					mediaFileId: data.mediaFileId,
					mode: data.decision.mode,
				});
			}

			context.logger?.debug("Starting session", {
				sessionId: data.sessionId,
				mediaFileId: data.mediaFileId,
				mode: data.decision.mode,
			});
			let result: StreamInitResult | undefined;
			let failure: ReturnType<typeof toDomainError> | undefined;
			try {
				await this.dependencies.startSession(data.sessionId, data.filePath, data.decision, 0, context.correlationId);
				context.signal?.throwIfAborted();
				result = { success: true, message: `Session started for ${data.sessionId}` };
			} catch (error) {
				failure = toDomainError(error, `Stream initialization failed: ${data.sessionId}`);
			}

			try {
				this.dependencies.releaseSessionReservation(data.sessionId);
			} catch (releaseError) {
				failure ??= toDomainError(releaseError, `Stream reservation cleanup failed: ${data.sessionId}`);
			}

			// discardSession() no-ops while the reservation is pending — releasing it must run first, or the access entry leaks forever.
			try {
				await this.dependencies.discardSession(data.sessionId);
			} catch (discardError) {
				failure ??= toDomainError(discardError, `Stream cleanup failed: ${data.sessionId}`);
			}

			if (failure) throw failure;

			if (!result) throw new InternalError(`Stream initialization returned no result: ${data.sessionId}`);

			return result;
		} catch (error) {
			throw toDomainError(error, `Stream initialization failed: ${data.sessionId}`);
		}
	}
}

export const streamInitializer = new StreamInitializer();
