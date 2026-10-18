import { clearSimilarIdsCache } from "@/app/repositories/metadata-recommendations.reader";
import type { createLogger } from "@/utils/logger.utils";
import { invalidateResponseBodies } from "@/utils/response-body.cache";

export interface MetadataServiceState {
	readonly serviceName: string;
	readonly logger: ReturnType<typeof createLogger>;
}

/** Arguments of a state-taking service function, without the leading state parameter. */
export type WithoutState<F> = F extends (state: never, ...rest: infer R) => unknown ? R : never;

/** Clears every read cache whose content depends on metadata/relations. */
export function invalidateReadCaches(): void {
	invalidateResponseBodies();
	clearSimilarIdsCache();
}
