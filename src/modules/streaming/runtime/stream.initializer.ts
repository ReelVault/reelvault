import type { PlaybackDecision } from "@reelvault/sdk/common";
import { toDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { streamingManager } from "./streaming.manager";

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

export interface StreamSessionStartInput {
	sessionId: string;
	filePath: string;
	decision: PlaybackDecision;
	startTime: number;
	operationId?: string | undefined;
	signal?: AbortSignal | undefined;
}

export interface StreamInitializerDependencies {
	startSession(input: StreamSessionStartInput): Promise<void>;
	discardSession(sessionId: string): Promise<void>;
	releaseSessionReservation(sessionId: string): void;
}

const defaultDependencies: StreamInitializerDependencies = {
	startSession: (input) =>
		streamingManager.startSession({
			sessionId: input.sessionId,
			inputPath: input.filePath,
			decision: input.decision,
			startTime: input.startTime,
			operationId: input.operationId,
			signal: input.signal,
		}),
	discardSession: (sessionId) => streamingManager.discardSession(sessionId),
	releaseSessionReservation: (sessionId) => streamingManager.releaseSessionReservation(sessionId),
};

export class StreamInitializer {
	private readonly dependencies: StreamInitializerDependencies;

	constructor(dependencies: StreamInitializerDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async initialize(data: StreamInitData, context: ApplicationContext): Promise<StreamInitResult> {
		try {
			context.signal?.throwIfAborted();
			context.logger?.debug("Starting session", {
				sessionId: data.sessionId,
				mediaFileId: data.mediaFileId,
				mode: data.decision.mode,
			});

			let failure: ReturnType<typeof toDomainError> | undefined;
			try {
				await this.dependencies.startSession({
					sessionId: data.sessionId,
					filePath: data.filePath,
					decision: data.decision,
					startTime: 0,
					operationId: context.correlationId,
					signal: context.signal,
				});
				context.signal?.throwIfAborted();
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

			return { success: true, message: `Session started for ${data.sessionId}` };
		} catch (error) {
			throw toDomainError(error, `Stream initialization failed: ${data.sessionId}`);
		}
	}
}

export const streamInitializer = new StreamInitializer();
