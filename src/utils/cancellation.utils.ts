export class CancellationError extends Error {
	constructor(message = "Worker item was cancelled") {
		super(message);
		this.name = "CancellationError";
	}
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof CancellationError ? signal.reason : new CancellationError();
	}
}
