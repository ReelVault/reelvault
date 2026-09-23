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

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("ImageCacheEviction");
		this.dependencies = dependencies;
	}

	async evictIfDue(cacheDir: string): Promise<void> {
		this.writesSinceLastSweep++;
		if (this.writesSinceLastSweep < IMAGE_CACHE_RECHECK_WRITES) return;

		this.writesSinceLastSweep = 0;

		const names = await this.dependencies.listDirectory(cacheDir);
		if (names.length <= IMAGE_CACHE_MAX_ENTRIES) return;

		const stats = await PromiseUtils.mapConcurrent(names, this.dependencies.getIoConcurrency(), async (name) => {
			const path = PathUtils.join(cacheDir, name);
			const fileStat = await this.dependencies.getStats(path);

			return { path, mtimeMs: fileStat?.mtimeMs ?? 0 };
		});
		const sorted = stats.toSorted((a, b) => a.mtimeMs - b.mtimeMs);
		const excess = sorted.slice(0, sorted.length - IMAGE_CACHE_MAX_ENTRIES);
		await PromiseUtils.mapConcurrent(excess, this.dependencies.getIoConcurrency(), (entry) => this.dependencies.deleteFile(entry.path));
		this.logger.debug("Evicted stale optimized-image cache entries", { evicted: excess.length, kept: IMAGE_CACHE_MAX_ENTRIES });
	}
}

export const imageCacheEviction = new ImageCacheEviction();
