import type { FieldsConfig } from "@reelvault/sdk/common";
import { preparedListGenres, preparedListImages, preparedListRatings } from "./batched.reader";
import { loadJunctionRows, loadRelationRows, shouldLoadRelation } from "./explicit.reader";
import { preparedDetailRelations } from "./json.reader";
import { applyDetailRelations, emptyRelationData } from "./payload.mapper";
import type { DetailRelationsRow, MetadataRelationData, RelationClient } from "./relations.types";

/** Default detail projection: one prepared statement returns every relation as JSON. */
export function loadMergedDetailRelations(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
): void {
	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	const rows: DetailRelationsRow[] = preparedDetailRelations(client).all({ ids: JSON.stringify(metadataIds) });
	for (const row of rows) {
		const data = relationsByMetadataId.get(row.metadataId);
		if (data) applyDetailRelations(data, row);
	}

	for (const data of relationsByMetadataId.values()) {
		data.cast.sort((a, b) => a.sortOrder - b.sortOrder);
	}
}

/** Default list projection: batched per-relation queries — faster for a page of ids than per-row correlated subqueries. */
export function loadBatchedListRelations(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
): void {
	const ids = JSON.stringify(metadataIds);
	const genres = preparedListGenres(client).all({ ids });
	const images = preparedListImages(client).all({ ids });
	const ratings = preparedListRatings(client).all({ ids });

	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	for (const row of genres) relationsByMetadataId.get(row.metadataId)?.genres.push(row.data);

	for (const row of images) {
		relationsByMetadataId.get(row.metadataId)?.images.push({
			imageType: row.imageType,
			data: row.data,
		});
	}

	for (const row of ratings) {
		relationsByMetadataId.get(String(row.metadataId))?.rating.scores.push(row.data);
	}
}

/** Explicit-field projection: per-relation queries with exactly the requested columns. */
export async function loadExplicitRelations<F extends string>(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	isDetailPage: boolean,
): Promise<void> {
	const includes = (rel: string) => shouldLoadRelation(fields, rel, isDetailPage);

	const [[collections, companies, genres, keywords, providers], [cast, crew, images, ratings, lockedFields]] = await Promise.all([
		loadJunctionRows(client, metadataIds, fields, includes),
		loadRelationRows(client, metadataIds, fields, includes),
	]);

	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	for (const row of collections) relationsByMetadataId.get(row.metadataId)?.collections.push(row.data);

	for (const row of companies) relationsByMetadataId.get(row.metadataId)?.companies.push(row.data);

	for (const row of genres) relationsByMetadataId.get(row.metadataId)?.genres.push(row.data);

	for (const row of keywords) relationsByMetadataId.get(row.metadataId)?.keywords.push(row.data);

	for (const row of cast) {
		relationsByMetadataId.get(row.metadataId)?.cast.push({
			role: row.role ?? "",
			character: row.character ?? null,
			sortOrder: row.sortOrder ?? -1,
			data: row.data,
		});
	}

	for (const row of crew) {
		relationsByMetadataId.get(row.metadataId)?.crew.push({
			job: row.job ?? "",
			department: row.department ?? "",
			data: row.data,
		});
	}

	for (const row of images) {
		relationsByMetadataId.get(row.metadataId)?.images.push({
			imageType: row.imageType,
			data: row.data,
		});
	}

	for (const row of ratings) {
		relationsByMetadataId.get(String(row.metadataId))?.rating.scores.push(row.data);
	}

	for (const row of providers) relationsByMetadataId.get(row.metadataId)?.providers.push(row.data);

	for (const row of lockedFields) relationsByMetadataId.get(row.metadataId)?.lockedFields.push(row.field);

	for (const data of relationsByMetadataId.values()) {
		data.cast.sort((a, b) => a.sortOrder - b.sortOrder);
	}
}
