import { eq, inArray, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat, SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { genreColumns, imageColumns, ratingColumns, selectColumns } from "./columns.constants";
import { idListSubquery } from "./json.reader";
import type { NamedRelationParams, RelationClient } from "./relations.types";

export function loadNamedRelation<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn>(
	client: DatabaseTransaction,
	metadataIds: string[] | SQL,
	params: NamedRelationParams<TSelection, TMetadataId>,
) {
	return client
		.select({ metadataId: params.metadataId, data: params.data })
		.from(params.junctionTable)
		.innerJoin(params.entityTable, eq(params.entityTable.id, params.entityColumn))
		.where(inArray(params.metadataId, metadataIds));
}

/** Batched list relations: one prepared query per relation is faster for a page of ids than per-row correlated subqueries. */
function preparedBatchedRelation<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn>(
	params: NamedRelationParams<TSelection, TMetadataId>,
	orderBy: SQL | SQLiteColumn,
) {
	return createPreparedQuery((client: RelationClient) => loadNamedRelation(client, idListSubquery, params).orderBy(orderBy).prepare());
}

export const preparedListGenres = preparedBatchedRelation(
	{
		metadataId: schema.metadataGenres.metadataId,
		junctionTable: schema.metadataGenres,
		entityColumn: schema.metadataGenres.genreId,
		entityTable: schema.genres,
		data: selectColumns(undefined, genreColumns),
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
