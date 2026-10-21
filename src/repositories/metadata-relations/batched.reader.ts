import { inArray, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { loadNamedRelation, type NamedRelationParams } from "@/integrations/drizzle-orm/utils/named-relation.reader";
import { imageColumns, ratingColumns, selectColumns } from "./columns.constants";
import { idListSubquery } from "./json.reader";
import { NAMED_RELATIONS } from "./named-relations.constants";
import type { RelationClient } from "./relations.types";

export { loadNamedRelation };

/** Batched list relations: one prepared query per relation is faster for a page of ids than per-row correlated subqueries. */
function preparedBatchedRelation<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn>(
	params: NamedRelationParams<TSelection, TMetadataId>,
	orderBy: SQL | SQLiteColumn,
) {
	return createPreparedQuery((client: RelationClient) => loadNamedRelation(client, idListSubquery, params).orderBy(orderBy).prepare());
}

export const preparedListGenres = preparedBatchedRelation(
	{
		metadataId: NAMED_RELATIONS.genres.metadataId,
		junctionTable: NAMED_RELATIONS.genres.junctionTable,
		entityColumn: NAMED_RELATIONS.genres.entityColumn,
		entityTable: NAMED_RELATIONS.genres.entityTable,
		data: selectColumns(undefined, NAMED_RELATIONS.genres.columns),
	},
	schema.genres.id,
);

export const preparedListImages = createPreparedQuery((client: RelationClient) =>
	client
		.select({
			metadataId: schema.metadataImages.metadataId,
			imageType: schema.metadataImages.imageType,
			data: selectColumns(undefined, imageColumns),
		})
		.from(schema.metadataImages)
		.innerJoin(schema.images, metadataImageOn)
		.where(inArray(schema.metadataImages.metadataId, idListSubquery))
		.orderBy(schema.metadataImages.imageType, schema.metadataImages.imageId)
		.prepare(),
);

export const preparedListRatings = createPreparedQuery((client: RelationClient) =>
	client
		.select({ metadataId: schema.metadataRatings.metadataId, data: selectColumns(undefined, ratingColumns) })
		.from(schema.metadataRatings)
		.where(inArray(schema.metadataRatings.metadataId, idListSubquery))
		.orderBy(schema.metadataRatings.source)
		.prepare(),
);
