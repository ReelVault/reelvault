import type {
	CreatePerson,
	FieldsConfig,
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	PersonFilters,
	PersonSorting,
	PersonWithRelations,
	SelectFields,
	UpdatePerson,
} from "@reelvault/sdk/common";
import type { ProviderResultCast, ProviderResultCrew } from "@reelvault/sdk/plugin";
import { eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { applyFields, includesField } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { filterEquals } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { parseStandardQuery, type QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import type { PrimaryIdReadParams } from "@/integrations/drizzle-orm/query/primary-id.reader";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { findPageWithQueryMap } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import {
	defineRepository,
	defineTableAccess,
	parseFieldsForRead,
} from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { buildRelationProjection } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import { findFirstProviderLinkFor } from "@/integrations/drizzle-orm/utils/provider-link.reader";
import { createLocalStableKey, createProviderPersonId, createProviderStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { metadataRepository } from "@/repositories/metadata.repository";
import { toMap } from "@/utils/array.utils";
import { isNonEmptyString } from "@/utils/type.utils";
import { providersRepository } from "./providers.repository";

const people = defineTableAccess("people", {
	primaryKeyColumn: "id",
});
const personProviders = defineTableAccess("personProviders", {
	primaryKeyColumn: "personId",
});
const imageColumns = getTableColumns(schema.images);

const personQueryMap: QueryMap<PersonFilters, PersonSorting> = {
	filters: { name: (value: string) => filterEquals(schema.people.name, value) },
	orderBy: { name: schema.people.name, createdAt: schema.people.createdAt, updatedAt: schema.people.updatedAt },
	defaults: { sortBy: "name", sortOrder: "asc" },
};

const overrides = {
	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & PersonFilters & PersonSorting,
	): Promise<PaginatedResponse<SelectFields<PersonWithRelations, F>>> {
		return await findPageWithQueryMap({
			access: people,
			queryMap: personQueryMap,
			query,
			findMany: (params) => getPeopleRepository().findMany(params),
		});
	},

	async findByIdForRead<F extends string>(personId: string, query?: FieldsQuery<F>) {
		return await getPeopleRepository().findByPrimaryId({ primaryId: personId, fields: parseFieldsForRead(query) });
	},

	async createAndRead<F extends string>(
		body: CreatePerson,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const { fields } = parseStandardQuery(query);
		const person = await getPeopleRepository().findOrCreateByName({ name: body.name, values: body });
		if (!person) return undefined;

		if (!(includesField(fields, "image") && person.imageId)) {
			return applyFields<PersonWithRelations, F>({ ...person, image: null }, fields);
		}

		return await getPeopleRepository().findByPrimaryId({ primaryId: person.id, fields });
	},

	async updateAndRead<F extends string>(
		personId: string,
		values: UpdatePerson,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const { fields } = parseStandardQuery(query);
		const [person] = await people.updateReturning({ primaryId: personId, values });
		if (!person) return undefined;

		return await attachImage(person, fields);
	},

	/**
	 * Get all people with optional search
	 */
	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<PersonWithRelations, F>>> {
		const data = await selectManyWithFields(people, { fields, required: ["id", "imageId"], where, orderBy, limit, offset, tx });
		const imageIds = includesField(fields, "image") ? data.flatMap((p) => (p.imageId ? [p.imageId] : [])) : [];
		let images: Map<string, NonNullable<PersonWithRelations["image"]>>;
		if (imageIds.length > 0) {
			images = await loadImages(imageIds, tx, fields);
		} else {
			images = new Map<string, NonNullable<PersonWithRelations["image"]>>();
		}

		return data.map((item) =>
			applyFields<PersonWithRelations, F>({ ...item, image: item.imageId ? (images.get(item.imageId) ?? null) : null }, fields),
		);
	},

	/**
	 * Get a single person by ID
	 */
	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: PrimaryIdReadParams<F>): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const person = await people.selectFirstById({ primaryId, tx });

		if (!person) return undefined;

		return await attachImage(person, fields, tx);
	},

	async findOrCreateByName({ name, values, tx }: { name: string; values: CreatePerson; tx?: DatabaseTransaction }) {
		return await people.findOrCreate({
			where: eq(people.table.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "person", value: name }) },
			tx,
		});
	},

	/** Raw person row without the relation graph — used by refresh flows. */
	async findByIdRaw(personId: string): Promise<typeof schema.people.$inferSelect | undefined> {
		return await people.selectFirst({ where: eq(people.primaryKeyColumn, personId) });
	},

	/** First provider link for a person (id + provider name), if any. */
	async findFirstProviderLink(personId: string): Promise<{ externalId: string; name: string } | undefined> {
		return await findFirstProviderLinkFor(schema.personProviders, schema.personProviders.personId, personId);
	},

	async processMetadataCredits({
		metadataId,
		providerName,
		cast = [],
		crew,
		tx,
	}: {
		metadataId: string;
		providerName: string;
		cast?: ProviderResultCast[] | undefined;
		crew?: ProviderResultCrew[] | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		const validCast = cast.filter((credit) => isNonEmptyString(credit.id) && isNonEmptyString(credit.name));
		const validCrew = (crew ?? []).filter((credit) => isNonEmptyString(credit.id) && isNonEmptyString(credit.name));
		const credits = [...validCast, ...validCrew];
		if (credits.length === 0) return [];

		const creditsByExternalId = new Map<string, (typeof credits)[number]>();
		for (const credit of credits) {
			const externalId = credit.id.trim();
			const current = creditsByExternalId.get(externalId);
			if (!current || (!current.profilePath && credit.profilePath)) creditsByExternalId.set(externalId, credit);
		}

		const externalIds = [...creditsByExternalId.keys()];
		const providers = await providersRepository.upsertByStableKey(
			externalIds.map((externalId) => ({
				stableKey: createProviderStableKey({ providerName, entityType: "person", externalId }),
				name: providerName,
				entityType: "person",
				externalId,
			})),
			tx,
		);
		const providerIds = toMap(
			providers,
			(provider) => provider.externalId,
			(provider) => provider.id,
		);

		const peopleValues = [...creditsByExternalId].map(([externalId, credit]) => ({
			id: createProviderPersonId(providerName, externalId),
			stableKey: createProviderStableKey({ providerName, entityType: "person", externalId }),
			name: credit.name.trim(),
			popularity: credit.popularity,
			gender: credit.gender,
		}));
		if (peopleValues.length > 0) {
			await forEachChunked(peopleValues, (values) =>
				people.upsert({
					values,
					target: people.table.stableKey,
					set: {
						name: sql`excluded.name`,
						popularity: sql`excluded.popularity`,
						gender: sql`excluded.gender`,
						updatedAt: new Date(),
					},
					tx,
				}),
			);
		}

		const providerLinks = externalIds.flatMap((externalId) => {
			const providerId = providerIds.get(externalId);

			return providerId ? [{ personId: createProviderPersonId(providerName, externalId), providerId }] : [];
		});
		await forEachChunked(providerLinks, (values) => personProviders.insert({ values, tx }));

		const uniqueCast = [
			...toMap(validCast, (credit) => `${createProviderPersonId(providerName, credit.id.trim())}:${credit.role}`).values(),
		];
		const uniqueCrew = [
			...toMap(validCrew, (credit) => `${createProviderPersonId(providerName, credit.id.trim())}:${credit.job}`).values(),
		];

		const castValues = uniqueCast.map((credit) => ({
			metadataId,
			personId: createProviderPersonId(providerName, credit.id.trim()),
			role: credit.role,
			character: credit.character,
			sortOrder: credit.order,
		}));
		await forEachChunked(castValues, (values) => metadataRepository.insertCast({ values, tx }));

		const crewValues = uniqueCrew.map((credit) => ({
			metadataId,
			personId: createProviderPersonId(providerName, credit.id.trim()),
			job: credit.job,
			department: credit.department,
		}));
		await forEachChunked(crewValues, (values) => metadataRepository.insertCrew({ values, tx }));

		return [...creditsByExternalId].flatMap(([externalId, credit]) => {
			const personId = createProviderPersonId(providerName, externalId);

			return credit.profilePath ? [{ personId, url: credit.profilePath }] : [];
		});
	},
};

export const peopleRepository = defineRepository(people, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getPeopleRepository() {
	return peopleRepository;
}

/**
 * Loads the avatar image (when the row references one and `fields` includes
 * it) and merges it into the person row under `image`.
 */
async function attachImage<F extends string>(
	person: Omit<PersonWithRelations, "image">,
	fields: FieldsConfig<F> | undefined,
	tx?: DatabaseTransaction,
): Promise<SelectFields<PersonWithRelations, F>> {
	let images: Map<string, NonNullable<PersonWithRelations["image"]>>;
	if (includesField(fields, "image")) {
		images = await loadImages(person.imageId ? [person.imageId] : [], tx, fields);
	} else {
		images = new Map<string, NonNullable<PersonWithRelations["image"]>>();
	}

	return applyFields<PersonWithRelations, F>({ ...person, image: person.imageId ? (images.get(person.imageId) ?? null) : null }, fields);
}

async function loadImages<F extends string>(imageIds: string[], tx?: DatabaseTransaction, fields?: FieldsConfig<F>) {
	if (imageIds.length === 0) return new Map<string, typeof schema.images.$inferSelect>();

	const client = databaseFactory.getClient({ tx });
	const projection = fields?.relations.image?.length ? buildRelationProjection(fields.relations.image, imageColumns, ["id"]) : undefined;

	let images: Array<typeof schema.images.$inferSelect>;
	if (projection) {
		images = await client.select(projection).from(schema.images).where(inArray(schema.images.id, imageIds));
	} else {
		images = await client.select().from(schema.images).where(inArray(schema.images.id, imageIds));
	}

	return toMap(images, (image) => image.id);
}
