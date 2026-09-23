export interface BatchChunk<T> {
	items: T[];
	/** Index one past the last item in `items` — the resume cursor for checkpointed enqueue loops. */
	nextCursor: number;
}

/**
 * Splits `items` into batches of `size`, starting at `startCursor`.
 * Unlike a plain chunk helper it reports the end index of every batch, so
 * checkpointed enqueue loops (library scan) can persist the resume cursor
 * after each batch without re-deriving it from the loop index.
 */
export function* batchChunks<T>(items: readonly T[], size: number, startCursor = 0): Generator<BatchChunk<T>> {
	for (let cursor = startCursor; cursor < items.length; cursor += size) {
		const end = Math.min(cursor + size, items.length);
		yield { items: items.slice(cursor, end), nextCursor: end };
	}
}
