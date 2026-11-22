import { clearRecommendationFeatureCensus } from "@/repositories/discover-recommendations.reader";
import { clearSimilarIdsCache } from "@/repositories/metadata-recommendations.reader";
import { invalidateResponseBodies } from "@/utils/response-body.cache";

/** Clears every read cache whose content depends on metadata/relations. */
export function invalidateReadCaches(): void {
	invalidateResponseBodies();
	clearSimilarIdsCache();
	clearRecommendationFeatureCensus();
}
