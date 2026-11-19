import { metadataRepository } from "@/repositories/metadata.repository";
import { assertExists } from "@/utils/domain.errors";

/**
 * Every id must be a catalog title: a stale id is a 404 here, not an FK violation
 * surfacing as a 500. The existence check needs no relation graph, so it reads only ids.
 */
export async function assertMetadataExists(metadataIds: readonly string[]): Promise<void> {
	const existing = await metadataRepository.findExistingIds(metadataIds);
	const missing = metadataIds.find((metadataId) => !existing.has(metadataId));
	assertExists(missing === undefined, "Metadata", missing);
}
