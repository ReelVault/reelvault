import { serverConstants } from "@/config/server/server.constants";
import { chunk } from "@/utils/array.utils";
import { mapConcurrent } from "@/utils/promise.utils";

/**
 * Runs `fn` over id/value lists chunked by `queryChunkSize` so one statement
 * cannot exceed SQLite's per-statement variable limit. Lists within the chunk
 * size run as a single call; oversized lists run one query per chunk —
 * sequentially by default (cross-chunk ordering is the caller's concern), or
 * concurrently when `concurrency` is given. Results are flattened in order.
 */
export async function mapChunked<T, R>(
	items: readonly T[],
	fn: (chunkItems: T[]) => Promise<R[]>,
	options?: { concurrency?: number | undefined },
): Promise<R[]> {
	if (items.length === 0) return [];

	const chunks = chunksFor(items);
	if (options?.concurrency !== undefined) {
		return (await mapConcurrent(chunks, options.concurrency, fn)).flat();
	}

	const results: R[] = [];
	for (const chunkItems of chunks) {
		results.push(...(await fn(chunkItems)));
	}

	return results;
}

/**
 * The chunks to run `fn` over: one chunk for a short list, otherwise
 * fixed-size chunks, so one statement cannot exceed SQLite's variable limit.
 */
function chunksFor<T>(items: readonly T[]): T[][] {
	if (items.length <= serverConstants.database.queryChunkSize) return [[...items]];

	return chunk([...items], serverConstants.database.queryChunkSize);
}

/** Same chunking contract as mapChunked for loops that only await a side effect (bulk INSERTs, deletes). */
export async function forEachChunked<T>(
	items: readonly T[],
	fn: (chunkItems: T[]) => Promise<unknown>,
	options?: { concurrency?: number | undefined },
): Promise<void> {
	if (items.length === 0) return;

	const chunks = chunksFor(items);
	if (options?.concurrency !== undefined) {
		await mapConcurrent(chunks, options.concurrency, fn);

		return;
	}

	for (const chunkItems of chunks) {
		await fn(chunkItems);
	}
}
