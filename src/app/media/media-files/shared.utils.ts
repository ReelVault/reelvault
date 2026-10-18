import type { MediaFileAuditResponse } from "@reelvault/sdk/common";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { notFoundError } from "@/utils/domain.errors";
import type { createLogger } from "@/utils/logger.utils";
import type { MemoryCache } from "@/utils/memory.cache";

export interface MediaServiceState {
	readonly serviceName: string;
	readonly logger: ReturnType<typeof createLogger>;
	/**
	 * Validated audit reports by operation id. A completed operation's result is
	 * immutable, but the client polls it repeatedly; without this, every poll
	 * re-parsed and re-validated the whole report against the TypeBox schema.
	 */
	readonly auditResultCache: MemoryCache<MediaFileAuditResponse>;
}

/** Arguments of a state-taking service function, without the leading state parameter. */
export type WithoutState<F> = F extends (state: never, ...rest: infer R) => unknown ? R : never;

export async function assertMediaFileExists(mediaFileId: string): Promise<void> {
	const mediaFileExists = await mediaRepository.isExists({ primaryId: mediaFileId });
	if (!mediaFileExists) throw notFoundError("MediaFile", mediaFileId);
}
