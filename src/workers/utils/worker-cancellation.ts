export class WorkerCancellationError extends Error {
	constructor(message = "Worker item was cancelled") {
		super(message);
		this.name = "WorkerCancellationError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof WorkerCancellationError ? signal.reason : new WorkerCancellationError();
	}
}
