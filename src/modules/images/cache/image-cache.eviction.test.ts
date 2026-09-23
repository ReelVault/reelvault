import { describe, expect, test } from "bun:test";
import { PathUtils } from "@/utils/path.utils";
import { ImageCacheEviction } from "./image-cache.eviction";

const CACHE_DIR = "/images/.cache";

interface Harness {
	eviction: ImageCacheEviction;
	entries: Map<string, { mtimeMs: number }>;
	deleted: string[];
}

function createHarness(): Harness {
	const entries = new Map<string, { mtimeMs: number }>();
	const deleted: string[] = [];
	const eviction = new ImageCacheEviction({
		listDirectory: async () => [...entries.keys()].map((path) => PathUtils.getFileName(path)),
		getStats: async (path) => entries.get(path) ?? null,
		deleteFile: (path) => {
			deleted.push(path);
			entries.delete(path);

			return Promise.resolve(true);
		},
		getIoConcurrency: () => 4,
	});

	return { eviction, entries, deleted };
}

function fillEntries(harness: Harness, count: number, firstMtimeMs: number): void {
	for (let index = 0; index < count; index++) {
		harness.entries.set(`${CACHE_DIR}/entry-${index}.webp`, { mtimeMs: firstMtimeMs + index });
	}
}

async function sweepDue(harness: Harness): Promise<void> {
	for (let writes = 0; writes < 500; writes++) await harness.eviction.evictIfDue(CACHE_DIR);
}

describe("ImageCacheEviction", () => {
	test("does not scan the directory before the recheck interval elapses", async () => {
		const entries = new Map<string, { mtimeMs: number }>();
		let scans = 0;
		const eviction = new ImageCacheEviction({
			listDirectory: () => {
				scans++;

				return Promise.resolve([...entries.keys()]);
			},
			getStats: () => Promise.resolve(null),
			deleteFile: () => Promise.resolve(true),
			getIoConcurrency: () => 4,
		});

		for (let writes = 1; writes < 500; writes++) await eviction.evictIfDue(CACHE_DIR);

		expect(scans).toBe(0);
	});

	test("scans on the recheck interval and keeps entries when the directory is under the cap", async () => {
		const harness = createHarness();
		fillEntries(harness, 5_000, 1);

		await sweepDue(harness);

		expect(harness.deleted).toEqual([]);
		expect(harness.entries.size).toBe(5_000);
	});

	test("evicts the oldest entries beyond the cap and keeps the newest ones", async () => {
		const harness = createHarness();
		fillEntries(harness, 5_020, 1);

		await sweepDue(harness);

		expect(harness.entries.size).toBe(5_000);
		for (let index = 0; index < 20; index++) expect(harness.entries.has(`${CACHE_DIR}/entry-${index}.webp`)).toBeFalse();

		expect(harness.entries.has(`${CACHE_DIR}/entry-20.webp`)).toBeTrue();
		expect(harness.deleted).toHaveLength(20);
	});

	test("treats a missing stat as the oldest possible entry", async () => {
		const harness = createHarness();
		fillEntries(harness, 5_000, 10);
		harness.entries.set(`${CACHE_DIR}/unreadable.webp`, { mtimeMs: 5 });

		await sweepDue(harness);

		expect(harness.deleted).toContain(`${CACHE_DIR}/unreadable.webp`);
		expect(harness.entries.size).toBe(5_000);
	});

	test("resets the write counter after a sweep so the next scan waits again", async () => {
		const harness = createHarness();
		fillEntries(harness, 5_001, 1);

		await sweepDue(harness);
		expect(harness.deleted).toHaveLength(1);

		await harness.eviction.evictIfDue(CACHE_DIR);
		expect(harness.deleted).toHaveLength(1);
	});
});
