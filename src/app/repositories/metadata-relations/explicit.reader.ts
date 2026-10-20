import type { FieldsConfig } from "@reelvault/sdk/common";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { includesField } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { loadNamedRelation } from "./batched.reader";
import { castColumns, crewColumns, imageColumns, personColumns, ratingColumns, selectColumns } from "./columns.constants";
import { NAMED_RELATIONS, type NamedRelationName } from "./named-relations.constants";
import type { RelationClient } from "./relations.types";

/** Plain junction relations (metadata↔entity lists) for explicit field projections. */
export function loadJunctionRows<F extends string>(
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	includes: (rel: string) => boolean,
) {
	const load = (name: NamedRelationName) =>
		loadIf(
			includes(name),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					...namedRelationBindings(name),
					data: selectColumns(relationFields(fields, name), NAMED_RELATIONS[name].columns),
				}),
		);

	return Promise.all([load("collections"), load("companies"), load("genres"), load("keywords"), load("providers")]);
}

/** The four junction bindings of one named relation, without its projection. */
function namedRelationBindings(name: NamedRelationName) {
	const relation = NAMED_RELATIONS[name];

	return {
		metadataId: relation.metadataId,
		junctionTable: relation.junctionTable,
		entityColumn: relation.entityColumn,
		entityTable: relation.entityTable,
	};
}

/** Person, media and rating relations for explicit field projections. */
export function loadRelationRows<F extends string>(
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	includes: (rel: string) => boolean,
) {
	return Promise.all([
		loadIf(
			includes("cast"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataCast.metadataId,
						...selectColumns(relationFields(fields, "cast"), castColumns),
						data: selectColumns(nestedRelationFields(relationFields(fields, "cast"), "data"), personColumns),
					})
					.from(schema.metadataCast)
					.innerJoin(schema.people, eq(schema.people.id, schema.metadataCast.personId))
					.where(inArray(schema.metadataCast.metadataId, metadataIds)),
		),
		loadIf(
			includes("crew"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataCrew.metadataId,
						...selectColumns(relationFields(fields, "crew"), crewColumns),
						data: selectColumns(nestedRelationFields(relationFields(fields, "crew"), "data"), personColumns),
					})
					.from(schema.metadataCrew)
					.innerJoin(schema.people, eq(schema.people.id, schema.metadataCrew.personId))
					.where(inArray(schema.metadataCrew.metadataId, metadataIds)),
		),
		loadIf(
			includes("images"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataImages.metadataId,
						imageType: schema.metadataImages.imageType,
						data: selectColumns(nestedRelationFields(relationFields(fields, "images"), "data"), imageColumns),
					})
					.from(schema.metadataImages)
					.innerJoin(schema.images, metadataImageOn)
					.where(inArray(schema.metadataImages.metadataId, metadataIds)),
		),
		loadIf(
			includes("rating"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataRatings.metadataId,
						data: selectColumns(ratingFields(fields), ratingColumns),
					})
					.from(schema.metadataRatings)
					.where(inArray(schema.metadataRatings.metadataId, metadataIds)),
		),
		loadIf(
			includes("lockedFields"),
			async () =>
				await client
					.select({ metadataId: schema.metadataLockedFields.metadataId, field: schema.metadataLockedFields.field })
					.from(schema.metadataLockedFields)
					.where(inArray(schema.metadataLockedFields.metadataId, metadataIds)),
		),
	]);
}

function relationFields<F extends string>(fields: FieldsConfig<F> | undefined, relation: string): Set<string> | undefined {
	if (!fields?.fields.length) return undefined;

	if (includesField(fields, relation)) return undefined;

	return new Set(fields.fields.filter((field) => field.startsWith(`${relation}.`)).map((field) => field.slice(relation.length + 1)));
}

function nestedRelationFields(fields: Set<string> | undefined, relation: string): Set<string> | undefined {
	if (!fields || fields.has(relation)) return undefined;

	const prefix = `${relation}.`;
	const result = new Set<string>();
	for (const field of fields) {
		if (field.startsWith(prefix)) result.add(field.slice(relation.length + 1));
	}

	return result;
}

function ratingFields<F extends string>(fields: FieldsConfig<F> | undefined): Set<string> | undefined {
	return nestedRelationFields(relationFields(fields, "rating"), "scores");
}

export function shouldLoadRelation<F extends string>(
	fields: FieldsConfig<F> | undefined,
	relation: string,
	isDetailPage: boolean,
): boolean {
	if (fields?.fields.length) {
		return includesField(fields, relation);
	}

	if (isDetailPage) return true;

	return relation === "images" || relation === "genres" || relation === "rating";
}

async function loadIf<T>(condition: boolean, load: () => T[] | Promise<T[]>): Promise<T[]> {
	if (!condition) return [];

	return await load();
}
