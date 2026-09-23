import { MemoryCache } from "@/utils/memory-cache";

// Coalesces concurrent identical optimizations: while one variant is being
// computed, every other request for the same cache path awaits its promise.
const INFLIGHT_TTL_MS = 60_000;
const INFLIGHT_MAX_SIZE = 200;

export class InflightDedup<T> {
	private readonly inFlight = new MemoryCache<Promise<T>>({
		ttlMs: INFLIGHT_TTL_MS,
		maxSize: INFLIGHT_MAX_SIZE,
		name: "image-optimization-inflight",
	});

	async run(key: string, task: () => Promise<T>): Promise<T> {
		const pending = this.inFlight.get(key);
		if (pending !== null) return await pending;

		const started = task();
		this.inFlight.set(key, started);
		try {
			return await started;
		} finally {
			this.inFlight.delete(key);
		}
	}
}
