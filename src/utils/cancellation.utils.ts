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

/** A signal that aborts after `ms`, or as soon as `parent` aborts, whichever comes first. */
export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ms);

	return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
