import { readdir } from "node:fs/promises";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";

// Bounded on-disk variants cache: oldest entries beyond the cap are removed
// after each RECHECK_WRITES-th cache write.
const IMAGE_CACHE_MAX_ENTRIES = 5_000;
const IMAGE_CACHE_RECHECK_WRITES = 500;

interface ServiceDependencies {
	listDirectory: (path: string) => Promise<string[]>;
	getStats: (path: string) => Promise<{ mtimeMs: number } | null>;
	deleteFile: (path: string) => Promise<boolean>;
	getIoConcurrency: () => number;
}

const defaultDependencies: ServiceDependencies = {
	listDirectory: (path) => readdir(path),
	getStats: (path) => FileUtils.getStats(path),
	deleteFile: (path) => FileUtils.delete(path),
	getIoConcurrency: () => systemResourcesService.getIoConcurrency(),
};

export class ImageCacheEviction extends BaseService {
	private readonly dependencies: ServiceDependencies;
	private writesSinceLastSweep = 0;
	/**
	 * Per-directory FIFO of cached file names, oldest first. The sweep only
	 * needs the oldest names, so tracking write order avoids stat'ing every file
	 * on every sweep (a full readdir + stat of a 5k–10k cache on a NAS/SD card is
	 * the dominant cost of the image path).
	 */
	private readonly tracked = new Map<string, Set<string>>();
	/** Directories whose pre-existing contents have been reconciled once. */
	private readonly reconciled = new Set<string>();

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ImageCacheEviction");
		this.dependencies = dependencies;
	}

	/** Records a cache write so FIFO eviction can order it without filesystem stats. */
	recordWrite(cacheDir: string, fileName: string): void {
		let names = this.tracked.get(cacheDir);
		if (!names) {
			names = new Set<string>();
			this.tracked.set(cacheDir, names);
		}

		names.add(fileName);
	}

	async evictIfDue(cacheDir: string): Promise<void> {
		this.writesSinceLastSweep++;
		if (this.writesSinceLastSweep < IMAGE_CACHE_RECHECK_WRITES) return;

		this.writesSinceLastSweep = 0;

		// The first sweep in this process must discover files left by earlier
		// runs; subsequent sweeps evict the tracked write order directly.
		if (!this.reconciled.has(cacheDir)) {
			this.reconciled.add(cacheDir);
			await this.reconcile(cacheDir);

			return;
		}

		await this.evictTracked(cacheDir);
	}

	/** One-off readdir + stat pass that trims pre-existing files and seeds the FIFO. */
	private async reconcile(cacheDir: string): Promise<void> {
		const names = await this.dependencies.listDirectory(cacheDir);
		const stats = await PromiseUtils.mapConcurrent(names, this.dependencies.getIoConcurrency(), async (name) => {
			const path = PathUtils.join(cacheDir, name);
			const fileStat = await this.dependencies.getStats(path);

			return { name, path, mtimeMs: fileStat?.mtimeMs ?? 0 };
		});
		const sorted = stats.toSorted((a, b) => a.mtimeMs - b.mtimeMs);
		const excessLength = Math.max(0, sorted.length - IMAGE_CACHE_MAX_ENTRIES);
		const excess = sorted.slice(0, excessLength);
		if (excess.length > 0) {
			await PromiseUtils.mapConcurrent(excess, this.dependencies.getIoConcurrency(), (entry) => this.dependencies.deleteFile(entry.path));
			this.logger.debug("Evicted stale optimized-image cache entries", { evicted: excess.length, kept: IMAGE_CACHE_MAX_ENTRIES });
		}

		// Seed oldest-first so later FIFO eviction keeps the same recency order.
		const tracked = new Set<string>();
		for (const entry of sorted.slice(excessLength)) tracked.add(entry.name);
		this.tracked.set(cacheDir, tracked);
	}

	/** Steady-state eviction: delete the oldest tracked names, no filesystem stats. */
	private async evictTracked(cacheDir: string): Promise<void> {
		const tracked = this.tracked.get(cacheDir);
		if (!tracked || tracked.size <= IMAGE_CACHE_MAX_ENTRIES) return;

		const excess = tracked.size - IMAGE_CACHE_MAX_ENTRIES;
		const toEvict: string[] = [];
		for (const name of tracked) {
			if (toEvict.length >= excess) break;
			toEvict.push(name);
		}

		await PromiseUtils.mapConcurrent(toEvict, this.dependencies.getIoConcurrency(), (name) =>
			this.dependencies.deleteFile(PathUtils.join(cacheDir, name)),
		);
		for (const name of toEvict) tracked.delete(name);
		this.logger.debug("Evicted stale optimized-image cache entries", { evicted: toEvict.length, kept: IMAGE_CACHE_MAX_ENTRIES });
	}
}

export const imageCacheEviction = new ImageCacheEviction();
