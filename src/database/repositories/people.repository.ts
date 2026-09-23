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
import { v5 as uuidv5 } from "uuid";
import { databaseFactory } from "@/database/database";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess, findPageWithQueryMap, forEachChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { buildRelationProjection } from "@/database/utils/media-file-projection";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { createLocalStableKey, createProviderStableKey } from "@/database/utils/stable-key";
import { toMap } from "@/utils/array.utils";
import { isNonEmptyString } from "@/utils/type.utils";
import { providersRepository } from "./providers.repository";

function createProviderPersonId(providerName: string, externalId: string): string {
	return uuidv5(`${providerName.trim()}:${externalId.trim()}`, uuidv5.URL);
}

const people = defineTableAccess("people", {
	primaryKeyColumn: "id",
});
const personProviders = defineTableAccess("personProviders", {
	primaryKeyColumn: "personId",
});
const imageColumns = getTableColumns(schema.images);

const personQueryMap: QueryMap<PersonFilters, PersonSorting> = {
	filters: { name: (value: string) => QueryFiltering.eq(schema.people.name, value) },
	orderBy: { name: schema.people.name, createdAt: schema.people.createdAt, updatedAt: schema.people.updatedAt },
	defaults: { sortBy: "name", sortOrder: "asc" },
};

class PeopleRepository {
	readonly table = schema.people;
	readonly primaryKeyColumn = people.primaryKeyColumn;
	readonly query = people.query;
	readonly selectMany = people.selectMany;
	readonly selectFirst = people.selectFirst;
	readonly findOrCreate = people.findOrCreate;
	readonly insert = people.insert;
	readonly update = people.update;
	readonly count = people.count;
	readonly isExists = people.isExists;
	readonly delete = people.delete;
	readonly insertReturning = people.insertReturning;
	readonly updateReturning = people.updateReturning;
	readonly updateAndReturn = people.updateAndReturn;
	readonly deleteReturning = people.deleteReturning;
	readonly deleteAndReturn = people.deleteAndReturn;
	readonly findByIds = people.findByIds;
	readonly findByColumnIn = people.findByColumnIn;
	private readonly insertProviders = personProviders.insert;

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & PersonFilters & PersonSorting,
	): Promise<PaginatedResponse<SelectFields<PersonWithRelations, F>>> {
		return await findPageWithQueryMap(people, personQueryMap, query, (params) => this.findMany(params));
	}

	async findByIdForRead<F extends string>(personId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findByPrimaryId({ primaryId: personId, fields });
	}

	async createAndRead<F extends string>(
		body: CreatePerson,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const person = await this.findOrCreateByName({ name: body.name, values: body });
		if (!person) return undefined;

		if (!(QueryFields.includes(fields, "image") && person.imageId)) {
			return QueryFields.apply<PersonWithRelations, F>({ ...person, image: null }, fields);
		}

		return await this.findByPrimaryId({ primaryId: person.id, fields });
	}

	async updateAndRead<F extends string>(
		personId: string,
		values: UpdatePerson,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const [person] = await this.updateReturning({ primaryId: personId, values });
		if (!person) return undefined;

		return await this.attachImage(person, fields);
	}

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
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });
		const imageIds = QueryFields.includes(fields, "image") ? data.flatMap((p) => (p.imageId ? [p.imageId] : [])) : [];
		const images =
			imageIds.length > 0 ? await this.loadImages(imageIds, tx, fields) : new Map<string, NonNullable<PersonWithRelations["image"]>>();

		return data.map((item) =>
			QueryFields.apply<PersonWithRelations, F>({ ...item, image: item.imageId ? (images.get(item.imageId) ?? null) : null }, fields),
		);
	}

	/**
	 * Loads the avatar image (when the row references one and `fields` includes
	 * it) and merges it into the person row under `image`.
	 */
	private async attachImage<F extends string>(
		person: Omit<PersonWithRelations, "image">,
		fields: FieldsConfig<F> | undefined,
		tx?: DatabaseTransaction,
	): Promise<SelectFields<PersonWithRelations, F>> {
		const images = QueryFields.includes(fields, "image")
			? await this.loadImages(person.imageId ? [person.imageId] : [], tx, fields)
			: new Map<string, NonNullable<PersonWithRelations["image"]>>();

		return QueryFields.apply<PersonWithRelations, F>(
			{ ...person, image: person.imageId ? (images.get(person.imageId) ?? null) : null },
			fields,
		);
	}

	/**
	 * Get a single person by ID
	 */
	async findByPrimaryId<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<PersonWithRelations, F> | undefined> {
		const person = await this.selectFirst({ where: eq(this.primaryKeyColumn, primaryId), tx });

		if (!person) return undefined;

		return await this.attachImage(person, fields, tx);
	}

	async findOrCreateByName({ name, values, tx }: { name: string; values: CreatePerson; tx?: DatabaseTransaction }) {
		return await this.findOrCreate({
			where: eq(this.table.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "person", value: name }) },
			tx,
		});
	}

	/** Raw person row without the relation graph — used by refresh flows. */
	async findByIdRaw(personId: string): Promise<typeof schema.people.$inferSelect | undefined> {
		return await this.selectFirst({ where: eq(this.primaryKeyColumn, personId) });
	}

	/** First provider link for a person (id + provider name), if any. */
	async findFirstProviderLink(personId: string): Promise<{ externalId: string; name: string } | undefined> {
		const [row] = await databaseFactory
			.getClient()
			.select({ externalId: schema.providers.externalId, name: schema.providers.name })
			.from(schema.personProviders)
			.innerJoin(schema.providers, eq(schema.providers.id, schema.personProviders.providerId))
			.where(eq(schema.personProviders.personId, personId))
			.limit(1);

		return row;
	}

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
				databaseFactory
					.getClient({ tx })
					.insert(this.table)
					.values(values)
					.onConflictDoUpdate({
						target: this.table.stableKey,
						set: {
							name: sql`excluded.name`,
							popularity: sql`excluded.popularity`,
							gender: sql`excluded.gender`,
							updatedAt: new Date(),
						},
					}),
			);
		}

		const providerLinks = externalIds.flatMap((externalId) => {
			const providerId = providerIds.get(externalId);

			return providerId ? [{ personId: createProviderPersonId(providerName, externalId), providerId }] : [];
		});
		await forEachChunked(providerLinks, (values) => this.insertProviders({ values, tx }));

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
	}

	private async loadImages<F extends string>(imageIds: string[], tx?: DatabaseTransaction, fields?: FieldsConfig<F>) {
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
}

export const peopleRepository = new PeopleRepository();
