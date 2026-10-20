import { describe, expect, test } from "bun:test";
import { getFileName } from "@/utils/path.utils";
import { ImageCacheEviction } from "./image-cache.eviction";

const CACHE_DIR = "/images/.cache";

interface Harness {
	eviction: ImageCacheEviction;
	entries: Map<string, { mtimeMs: number }>;
	deleted: string[];
	/** Listed in the directory, but without stats. */
	unreadable: Set<string>;
}

function createHarness(): Harness {
	const entries = new Map<string, { mtimeMs: number }>();
	const deleted: string[] = [];
	const unreadable = new Set<string>();
	const eviction = new ImageCacheEviction({
		listDirectory: async () => [...entries.keys(), ...unreadable].map((path) => getFileName(path)),
		getStats: async (path) => (unreadable.has(path) ? null : (entries.get(path) ?? null)),
		deleteFile: (path) => {
			deleted.push(path);
			entries.delete(path);
			unreadable.delete(path);

			return Promise.resolve(true);
		},
		getIoConcurrency: () => 4,
	});

	return { eviction, entries, deleted, unreadable };
}

function fillEntries(entries: Map<string, { mtimeMs: number }>, count: number, firstMtimeMs: number): void {
	for (let index = 0; index < count; index++) {
		entries.set(`${CACHE_DIR}/entry-${index}.webp`, { mtimeMs: firstMtimeMs + index });
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

	test("keeps every entry while the directory is at the cap", async () => {
		const harness = createHarness();
		fillEntries(harness.entries, 5_000, 1);

		await sweepDue(harness);

		expect(harness.deleted).toEqual([]);
		expect(harness.entries.size).toBe(5_000);
	});

	test("evicts the oldest entries beyond the cap and keeps the newest ones", async () => {
		const harness = createHarness();
		fillEntries(harness.entries, 5_020, 1);

		await sweepDue(harness);

		expect(harness.entries.size).toBe(5_000);
		for (let index = 0; index < 20; index++) expect(harness.entries.has(`${CACHE_DIR}/entry-${index}.webp`)).toBeFalse();

		expect(harness.entries.has(`${CACHE_DIR}/entry-20.webp`)).toBeTrue();
		expect(harness.deleted).toHaveLength(20);
	});

	test("treats an entry without stats as the oldest possible entry", async () => {
		const harness = createHarness();
		fillEntries(harness.entries, 5_000, 10);
		const unreadableFile = `${CACHE_DIR}/unreadable.webp`;
		harness.unreadable.add(unreadableFile);

		await sweepDue(harness);

		expect(harness.deleted).toEqual([unreadableFile]);
		expect(harness.entries.size).toBe(5_000);
	});

	test("resets the write counter after a sweep so the next scan waits again", async () => {
		const harness = createHarness();
		fillEntries(harness.entries, 5_001, 1);

		await sweepDue(harness);
		expect(harness.deleted).toHaveLength(1);

		await harness.eviction.evictIfDue(CACHE_DIR);
		expect(harness.deleted).toHaveLength(1);
	});
});

describe("ImageCacheEviction steady-state eviction", () => {
	test("keeps a rewritten file and evicts the next oldest one instead", async () => {
		const harness = createHarness();
		fillEntries(harness.entries, 5_000, 1);

		// First sweep reconciles the directory and seeds the write order.
		await sweepDue(harness);
		expect(harness.deleted).toEqual([]);

		// The oldest file is written again, then a new file pushes the tracked
		// set past the cap.
		harness.eviction.recordWrite(CACHE_DIR, "entry-0.webp");
		harness.eviction.recordWrite(CACHE_DIR, "entry-5000.webp");
		harness.entries.set(`${CACHE_DIR}/entry-5000.webp`, { mtimeMs: 2 });

		await sweepDue(harness);

		expect(harness.deleted).toEqual([`${CACHE_DIR}/entry-1.webp`]);
		expect(harness.entries.has(`${CACHE_DIR}/entry-0.webp`)).toBeTrue();
	});

	test("steady-state sweeps evict by tracked write order without filesystem stats", async () => {
		let statCalls = 0;
		const entries = new Map<string, { mtimeMs: number }>();
		const eviction = new ImageCacheEviction({
			listDirectory: () => Promise.resolve([...entries.keys()].map((path) => getFileName(path))),
			getStats: (path) => {
				statCalls++;
				return Promise.resolve(entries.get(path) ?? null);
			},
			deleteFile: (path) => {
				entries.delete(path);

				return Promise.resolve(true);
			},
			getIoConcurrency: () => 4,
		});

		fillEntries(entries, 5_001, 1);
		// First sweep reconciles pre-existing files (stats expected).
		for (let writes = 0; writes < 500; writes++) await eviction.evictIfDue(CACHE_DIR);
		expect(statCalls).toBeGreaterThan(0);
		expect(entries.size).toBe(5_000);

		statCalls = 0;
		for (let writes = 0; writes < 500; writes++) {
			eviction.recordWrite(CACHE_DIR, `new-${writes}.webp`);
			entries.set(`${CACHE_DIR}/new-${writes}.webp`, { mtimeMs: 1_000_000 + writes });
			await eviction.evictIfDue(CACHE_DIR);
		}

		expect(statCalls).toBe(0);
		expect(entries.size).toBe(5_000);
	});
});
