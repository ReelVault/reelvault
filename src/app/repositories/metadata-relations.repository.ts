import type { FieldsConfig, MetadataWithRelation } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { chunk } from "@/utils/array.utils";
import { calculateAverageScore } from "./metadata-recommendations.reader";
import { emptyRelationData } from "./metadata-relations/payload.mapper";
import { loadBatchedListRelations, loadExplicitRelations, loadMergedDetailRelations } from "./metadata-relations/relations.loader";
import type { MetadataRelationData } from "./metadata-relations/relations.types";

export async function loadRelations<F extends string>(
	metadataIds: string[],
	tx?: DatabaseTransaction,
	fields?: FieldsConfig<F>,
	isDetailPage = false,
): Promise<Map<string, MetadataRelationData>> {
	const relationsByMetadataId = new Map<string, MetadataRelationData>();
	if (metadataIds.length === 0) return relationsByMetadataId;

	// Recurse on chunk boundaries so each relation query stays within SQLite's
	// bound-variable limit. Each metadata id lands in exactly one chunk, so the
	// merged map is identical to a single unbounded load.
	if (metadataIds.length > serverConstants.database.queryChunkSize) {
		for (const idsChunk of chunk(metadataIds, serverConstants.database.queryChunkSize)) {
			for (const [id, data] of await loadRelations(idsChunk, tx, fields, isDetailPage)) {
				relationsByMetadataId.set(id, data);
			}
		}

		return relationsByMetadataId;
	}

	const client = databaseFactory.getClient({ tx });

	if (!fields?.fields.length) {
		if (isDetailPage) {
			loadMergedDetailRelations(relationsByMetadataId, client, metadataIds);
		} else {
			loadBatchedListRelations(relationsByMetadataId, client, metadataIds);
		}

		return relationsByMetadataId;
	}

	await loadExplicitRelations(relationsByMetadataId, client, metadataIds, fields, isDetailPage);

	return relationsByMetadataId;
}

export function withRelations(metadata: typeof schema.metadata.$inferSelect, relations?: MetadataRelationData): MetadataWithRelation {
	const data = relations ?? emptyRelationData();

	return {
		...metadata,
		...data,
		cast: data.cast,
		rating: {
			avgScore: calculateAverageScore(data.rating.scores, systemSettingsStore.get("metadata.ratingAggregation")) ?? 0,
			scores: data.rating.scores,
		},
		lockedFields: data.lockedFields,
	};
}
