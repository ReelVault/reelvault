import type { Logger } from "@sdk/common/logger";
import { DomainError, InternalError } from "@/utils/errors";

export interface TaskSchedulingOptions {
	operationId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined;
}

export interface ApplicationContext {
	signal?: AbortSignal | undefined;
	correlationId?: string | undefined;
	operationId?: string | undefined;
	taskId?: string | undefined;
	logger?: Logger | undefined;
	/** Re-arms the execution timeout (see WorkerHandlerContext.extendTimeout). */
	extendTimeout?: ((additionalMs: number) => void) | undefined;
}

export function toDomainError(error: unknown, fallbackMessage: string): DomainError {
	if (error instanceof DomainError) return error;

	const message = error instanceof Error && error.message ? error.message : fallbackMessage;

	return new InternalError(message, { cause: error });
}

/** Wraps an async function so any thrown error is converted to a `DomainError`. */
export async function withDomainError<T>(label: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw toDomainError(error, label);
	}
}
