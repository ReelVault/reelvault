import { MINUTE } from "@/server.constants";
import { FileUtils, fileStatSignature } from "@/utils/file.utils";
import { MemoryCache } from "@/utils/memory-cache";

interface ServiceDependencies {
	getStats: (path: string) => Promise<{ size: number; mtimeMs: number } | null>;
}

const defaultDependencies: ServiceDependencies = {
	getStats: (path) => FileUtils.getStats(path),
};

export class SourceVersionCache {
	private readonly versions = new MemoryCache<string>({ ttlMs: 5 * MINUTE, maxSize: 2000, name: "image-source-version" });
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	/**
	 * Version stamp derived from the source file's (size, mtime) so a replaced
	 * source never gets served from a cache entry keyed by its previous content.
	 */
	async read(sourcePath: string): Promise<string> {
		return await this.versions.getOrSet(sourcePath, async () => {
			const stats = await this.dependencies.getStats(sourcePath);

			return stats ? fileStatSignature(stats) : "0";
		});
	}
}

export const sourceVersionCache = new SourceVersionCache();
