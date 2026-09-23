import { librariesService } from "@/application/libraries/libraries.service";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { MemoryCache } from "@/utils/memory-cache";
import { PromiseUtils } from "@/utils/promise.utils";
import { metadataSidecarsService } from "./metadata-sidecars.service";

/** Assets found by a recursive library-root walk — same shape as one root's result. */
type IgnoredAssets = Awaited<ReturnType<typeof metadataSidecarsService.findIgnoredAssets>>;
const ASSETS_CACHE_TTL_MS = 30_000;

class SidecarAssetsService extends BaseService {
	// The walk is expensive and the result is only advisory; a short TTL absorbs
	// repeated admin refreshes.
	private readonly cache = new MemoryCache<IgnoredAssets>({ name: "library-sidecar-assets", ttlMs: ASSETS_CACHE_TTL_MS, maxSize: 128 });

	constructor() {
		super("SidecarAssetsService");
	}

	async getIgnoredAssets(libraryId: string): Promise<IgnoredAssets> {
		return await this.cache.getOrSet(libraryId, async () => {
			const library = await librariesService.getById(libraryId, { fields: "id,paths.path" });
			const assets = await PromiseUtils.mapConcurrent(
				library.paths,
				systemResourcesService.getIoConcurrency(),
				async (path) => await metadataSidecarsService.findIgnoredAssets(path.path),
			);

			return assets.flat();
		});
	}
}

export const sidecarAssetsService = new SidecarAssetsService();
