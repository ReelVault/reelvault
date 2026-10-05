import { expect, test } from "bun:test";
import { MemoryCache } from "./memory-cache";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});

	return { promise, resolve, reject };
}

test("mget reads only present/fresh entries", () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });

	cache.set("a", 1);
	cache.set("b", 2);
	cache.set("c", 3);

	const result = cache.mget(["a", "b", "missing"]);
	expect(result.get("a")).toBe(1);
	expect(result.get("b")).toBe(2);
	expect(result.has("missing")).toBe(false);
	expect(result.size).toBe(2);
});

test("mget increments hits/misses per key like individual get() calls", () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });
	cache.set("a", 1);

	cache.mget(["a", "missing"]);
	const stats = cache.stats();
	expect(stats.hits).toBe(1);
	expect(stats.misses).toBe(1);
});

test("getOrSetMany returns cached values without invoking the loader for them", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });
	cache.set("a", 1);

	let requestedKeys: readonly string[] = [];
	const result = await cache.getOrSetMany(["a", "b"], (missing) => {
		requestedKeys = missing;

		return Promise.resolve(new Map([["b", 2]]));
	});

	expect(requestedKeys).toEqual(["b"]);
	expect(result.get("a")).toBe(1);
	expect(result.get("b")).toBe(2);
	expect(cache.get("b")).toBe(2); // now cached for next time
});

test("getOrSetMany caches only the keys the loader actually returns", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });

	const result = await cache.getOrSetMany(["a", "b"], async () => new Map([["a", 1]]));

	expect(result.get("a")).toBe(1);
	expect(result.has("b")).toBe(false);
	expect(cache.has("b")).toBe(false);
});

test("getOrSetMany accepts an entries array return value from the loader", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });

	const result = await cache.getOrSetMany(["a", "b"], async () => [
		["a", 1],
		["b", 2],
	]);

	expect(result.get("a")).toBe(1);
	expect(result.get("b")).toBe(2);
});

test("getOrSetMany rejects and caches nothing when the loader throws", () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });

	expect(
		cache.getOrSetMany(["a", "b"], () => {
			throw new Error("batch failed");
		}),
	).rejects.toThrow("batch failed");

	expect(cache.has("a")).toBe(false);
	expect(cache.has("b")).toBe(false);
	expect(cache.stats().pendingLoads).toBe(0);
});

test("getOrSetMany dedupes against a concurrent single-key getOrSet for the same key", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });
	let batchLoaderCalls = 0;
	let singleLoaderCalls = 0;

	const batchPromise = cache.getOrSetMany(["shared"], async (missing) => {
		batchLoaderCalls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 15);
		});

		return new Map(missing.map((key) => [key, 99]));
	});

	// Fired while the batch load is in flight — should ride along, not reload.
	const singlePromise = cache.getOrSet("shared", () => {
		singleLoaderCalls++;

		return Promise.resolve(1);
	});

	const [batchResult, singleResult] = await Promise.all([batchPromise, singlePromise]);

	expect(batchLoaderCalls).toBe(1);
	expect(singleLoaderCalls).toBe(0);
	expect(batchResult.get("shared")).toBe(99);
	expect(singleResult).toBe(99);
});

test("getOrSetMany dedupes two concurrent batch calls sharing a missing key", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });
	let loaderCalls = 0;

	const loader = async (missing: readonly string[]) => {
		loaderCalls++;
		await new Promise((resolve) => {
			setTimeout(resolve, 15);
		});

		return new Map(missing.map((key) => [key, key.length]));
	};

	const [r1, r2] = await Promise.all([
		cache.getOrSetMany(["shared"], loader),
		cache.getOrSet("shared", async () => {
			const value = (await loader(["shared"])).get("shared");
			if (value === undefined) throw new Error("shared missing from loader result");

			return value;
		}),
	]);

	expect(r1.get("shared")).toBe(r2);
	expect(loaderCalls).toBe(1);
});

test("getOrSetMany with an unresolved key from the loader does not produce an unhandled rejection", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });

	// "b" is requested but never returned by the loader, and nothing separately
	// calls getOrSet("b") to consume its per-key pending promise. This should
	// resolve cleanly without an unhandled rejection warning.
	const result = await cache.getOrSetMany(["a", "b"], async () => new Map([["a", 1]]));
	expect(result.get("a")).toBe(1);

	// Give any stray unhandled rejection a chance to surface in this tick.
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
	expect(cache.stats().pendingLoads).toBe(0);
});

test("getOrRun coalesces concurrent calls for the same key into one loader run", async () => {
	const cache = new MemoryCache<string>({ ttlMs: -1, maxSize: -1 });
	let runs = 0;
	const gate = deferred<string>();
	const loader = () => {
		runs++;

		return gate.promise;
	};

	const first = cache.getOrRun("key-1", loader);
	const second = cache.getOrRun("key-1", loader);

	gate.resolve("value");
	expect(await first).toBe("value");
	expect(await second).toBe("value");
	expect(runs).toBe(1);
});

test("getOrRun runs the loader again once the previous run settled (no result caching)", async () => {
	const cache = new MemoryCache<number>({ ttlMs: -1, maxSize: -1 });
	let runs = 0;
	const loader = () => {
		runs++;

		return Promise.resolve(runs);
	};

	expect(await cache.getOrRun("key-1", loader)).toBe(1);
	expect(await cache.getOrRun("key-1", loader)).toBe(2);
	expect(runs).toBe(2);
	expect(cache.get("key-1")).toBeNull();
});

test("getOrRun keeps independent keys independent", async () => {
	const cache = new MemoryCache<string>({ ttlMs: -1, maxSize: -1 });

	expect(await Promise.all([cache.getOrRun("a", async () => "A"), cache.getOrRun("b", async () => "B")])).toEqual(["A", "B"]);
});

test("getOrRun propagates a failure to every waiter without poisoning the next run", async () => {
	const cache = new MemoryCache<string>({ ttlMs: -1, maxSize: -1 });
	let runs = 0;
	const gate = deferred<string>();
	const loader = () => {
		runs++;

		return gate.promise;
	};

	const first = cache.getOrRun("key-1", loader);
	const second = cache.getOrRun("key-1", loader);
	first.catch(() => undefined);
	second.catch(() => undefined);
	gate.reject(new Error("optimize failed"));

	await expect(first).rejects.toThrow("optimize failed");
	await expect(second).rejects.toThrow("optimize failed");
	expect(runs).toBe(1);
	expect(cache.stats().pendingLoads).toBe(0);

	expect(await cache.getOrRun("key-1", async () => "recovered")).toBe("recovered");
});
