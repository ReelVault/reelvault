import { describe, expect, test } from "bun:test";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";
import { enqueueInBatches } from "./batch-enqueue.utils";

describe("enqueueInBatches", () => {
	test("inserts one batch per chunk and reports the cursor after each chunk", async () => {
		const items = Array.from({ length: ENQUEUE_BATCH_SIZE * 2 + 1 }, (_, index) => index);
		const chunkSizes: number[] = [];
		const cursors: number[] = [];

		const result = await enqueueInBatches({
			items,
			batch: (chunk) => {
				chunkSizes.push(chunk.length);

				return Promise.resolve();
			},
			item: async () => undefined,
			onChunk: (cursor) => {
				cursors.push(cursor);
			},
		});

		expect(chunkSizes).toEqual([ENQUEUE_BATCH_SIZE, ENQUEUE_BATCH_SIZE, 1]);
		expect(cursors).toEqual([ENQUEUE_BATCH_SIZE, ENQUEUE_BATCH_SIZE * 2, items.length]);
		expect(result).toEqual({ queued: items.length, cursor: items.length });
	});

	test("resumes from a persisted cursor", async () => {
		const inserted: number[] = [];

		const result = await enqueueInBatches({
			items: [0, 1, 2, 3, 4],
			cursor: 3,
			batch: (chunk) => {
				inserted.push(...chunk);

				return Promise.resolve();
			},
			item: async () => undefined,
		});

		expect(inserted).toEqual([3, 4]);
		expect(result).toEqual({ queued: 2, cursor: 5 });
	});

	test("falls back to per-item enqueueing when no batch insert is available", async () => {
		const inserted: number[] = [];
		const cursors: number[] = [];

		const result = await enqueueInBatches({
			items: [1, 2, 3],
			item: (entry) => {
				inserted.push(entry);

				return Promise.resolve();
			},
			onChunk: (cursor) => {
				cursors.push(cursor);
			},
		});

		expect(inserted.toSorted((left, right) => left - right)).toEqual([1, 2, 3]);
		expect(cursors).toEqual([3]);
		expect(result).toEqual({ queued: 3, cursor: 3 });
	});

	test("persists the cursor for an empty list instead of silently skipping it", async () => {
		const cursors: number[] = [];

		const result = await enqueueInBatches({
			items: [],
			item: () => {
				throw new Error("must not run");
			},
			onChunk: (cursor) => {
				cursors.push(cursor);
			},
		});

		expect(cursors).toEqual([0]);
		expect(result).toEqual({ queued: 0, cursor: 0 });
	});

	test("stops before the first batch when the signal is already aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("cancelled");
		controller.abort(reason);
		let batches = 0;

		await expect(
			enqueueInBatches({
				items: [1, 2],
				signal: controller.signal,
				batch: () => {
					batches++;

					return Promise.resolve();
				},
				item: async () => undefined,
			}),
		).rejects.toBe(reason);
		expect(batches).toBe(0);
	});
});
