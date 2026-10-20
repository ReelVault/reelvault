import { eq, inArray, type SQL } from "drizzle-orm";
import type { SelectedFieldsFlat, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";

export interface NamedRelationParams<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn> {
	metadataId: TMetadataId;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	data: TSelection;
}

/**
 * Joins a junction table to its entity table and returns the projected entity
 * rows keyed by the junction's owning id — the shared read behind every plain
 * metadata↔entity relation (and any other junction with the same shape).
 */
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
