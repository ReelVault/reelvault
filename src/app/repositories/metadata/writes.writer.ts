import type { CreateMetadata, FieldsQuery, MetadataWithRelation, SelectFields } from "@reelvault/sdk/common";
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { and, eq, type SQL } from "drizzle-orm";
import { providersRepository } from "@/app/repositories/providers.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { toMetadataValues } from "@/integrations/drizzle-orm/utils/metadata-values.mapper";
import { createLocalMetadataStableKey, createProviderStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { hasEntry } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { findById, getLockedFields } from "./queries.reader";
import { findMetadataProvider, logger, metadataProviders, metadataTable, normalizeProviderLinks } from "./shared.utils";

/** The scalar values a metadata row is written with. */
type MetadataInsertValues = Parameters<typeof metadataTable.findOrCreate>[0]["values"];

/**
 * A season/episode sync reported fallback-language content for this title —
 * raise the series-level flag so the admin missing-translation filter finds
 * it. Deliberately never clears the flag: child syncs see partial data, only
 * a full metadata refresh (own metadata + all seasons) may clear it.
 */
export async function flagMissingTranslation(metadataId: string, tx?: DatabaseTransaction): Promise<void> {
	const write = async (): Promise<void> => {
		await metadataTable.update({ primaryId: metadataId, values: { hasMissingTranslation: true }, tx });
	};

	// Inside a caller's transaction the write already holds the lock; standalone
	// callers queue on it instead of busy-waiting on an open transaction.
	if (tx) {
		await write();

		return;
	}

	await databaseFactory.runWrite(write);
}

export async function setLockedFields(metadataId: string, fields: readonly string[], tx?: DatabaseTransaction): Promise<void> {
	await runInTransaction(tx, async (transaction) => {
		const client = databaseFactory.getClient({ tx: transaction });
		await client.delete(schema.metadataLockedFields).where(eq(schema.metadataLockedFields.metadataId, metadataId));
		if (fields.length > 0) {
			const uniqueFields: string[] = [];
			const seen = new Set<string>();
			for (const f of fields) {
				const trimmed = f.trim();
				if (trimmed.length === 0 || seen.has(trimmed)) continue;

				seen.add(trimmed);
				uniqueFields.push(trimmed);
			}

			if (uniqueFields.length > 0) {
				await client.insert(schema.metadataLockedFields).values(
					uniqueFields.map((field) => ({
						metadataId,
						field,
					})),
				);
			}
		}
	});
}

export async function createAndRead<F extends string>(
	body: CreateMetadata,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
	const { fields } = QueryUtils.parseStandard(query);
	const { lockedFields, ...metadataValues } = body;
	const metadata = await databaseFactory.transaction(async (tx) => {
		const created = await findOrCreateByIdentity({
			title: metadataValues.title,
			type: metadataValues.type,
			releaseDate: metadataValues.releaseDate,
			values: metadataValues,
			tx,
		});
		if (created && lockedFields && lockedFields.length > 0) {
			await setLockedFields(created.id, lockedFields, tx);
		}

		return created;
	});

	if (!metadata) return undefined;

	return await findById({ primaryId: metadata.id, fields });
}

export async function updateAndRead<F extends string>(
	metadataId: string,
	values: CreateMetadata | Partial<CreateMetadata>,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
	const { fields } = QueryUtils.parseStandard(query);
	const { lockedFields, ...metadataValues } = values;

	await databaseFactory.transaction(async (tx) => {
		if (hasEntry(metadataValues)) {
			await metadataTable.update({ primaryId: metadataId, values: metadataValues, tx });
		}

		if (lockedFields !== undefined) {
			await setLockedFields(metadataId, lockedFields, tx);
		}
	});

	return await findById({ primaryId: metadataId, fields });
}

export async function findOrCreateByIdentity({
	title,
	type,
	releaseDate,
	values,
	tx,
}: {
	title: CreateMetadata["title"];
	type: CreateMetadata["type"];
	releaseDate: CreateMetadata["releaseDate"];
	values: CreateMetadata;
	tx?: DatabaseTransaction | undefined;
}) {
	const stableKey = createLocalMetadataStableKey({ title, type, releaseDate });
	const created = await metadataTable.findOrCreate({
		where: and(eq(schema.metadata.title, title), eq(schema.metadata.type, type), eq(schema.metadata.releaseDate, releaseDate)),
		values: { ...values, stableKey },
		tx,
	});
	if (created) return created;

	// The insert lost to the unique index on a case/Unicode variant of the same
	// identity (the fallback WHERE compared the raw values). The stable key is
	// the row identity, so re-read by it.
	return await metadataTable.selectFirst({ where: eq(schema.metadata.stableKey, stableKey), tx });
}

/** Applies the unlocked scalar values to an existing metadata row, or creates the row. */
async function upsertMetadataRow(
	metadata: typeof schema.metadata.$inferSelect | undefined,
	metadataValues: MetadataInsertValues,
	metadataWhere: SQL | undefined,
	tx: DatabaseTransaction | undefined,
): Promise<typeof schema.metadata.$inferSelect | undefined> {
	if (!metadata) return await metadataTable.findOrCreate({ where: metadataWhere, values: metadataValues, tx });

	// Never clobber scalar fields the user explicitly locked.
	const locked = new Set(await getLockedFields(metadata.id, tx));
	const updateValues: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadataValues)) {
		if (!locked.has(key)) updateValues[key] = value;
	}

	if (!hasEntry(updateValues)) return metadata;

	const [updated] = await databaseFactory
		.getClient({ tx })
		.update(schema.metadata)
		.set(updateValues)
		.where(eq(schema.metadata.id, metadata.id))
		.returning();

	return updated ?? metadata;
}

/**
 * Find or create metadata from provider result
 */
export async function findOrCreateMetadata({
	type,
	providerName,
	providers,
	results,
	matchScore,
	tx,
	mergeConflict,
}: {
	type: "movie" | "tv_show";
	providerName: string;
	providers?: ReadonlyArray<{ name: string; externalId: string }> | undefined;
	results: ProviderMetadataResult;
	matchScore?: number | undefined;
	tx?: DatabaseTransaction | undefined;
	/** Folds a raw-identity duplicate into the provider-linked row (the caller owns the merge repository). */
	mergeConflict?: ((targetId: string, sourceId: string) => Promise<void>) | undefined;
}) {
	const links = normalizeProviderLinks(providerName, results.externalId, providers);

	const existingLink = await findMetadataProvider({ externalId: results.externalId, name: providerName, entityType: type, tx });
	if (existingLink?.metadata) {
		await linkProviders(existingLink.metadata.id, type, links, tx);

		return { metadata: existingLink.metadata, created: false };
	}

	const stableKey = createProviderStableKey({ providerName, entityType: type, externalId: results.externalId });

	const metadataWhere = and(
		eq(schema.metadata.title, results.title),
		eq(schema.metadata.type, type),
		eq(schema.metadata.releaseDate, results.releaseDate),
	);
	const [existingByStableKey, candidateByIdentity] = await Promise.all([
		metadataTable.selectFirst({ where: eq(schema.metadata.stableKey, stableKey), tx }),
		metadataTable.selectFirst({ where: metadataWhere, tx }),
	]);
	if (existingByStableKey && candidateByIdentity && candidateByIdentity.id !== existingByStableKey.id && mergeConflict) {
		// The update below would collide with this duplicate's unique identity
		// (title, type, release_date); fold it into the provider-linked row first.
		await mergeConflict(existingByStableKey.id, candidateByIdentity.id);
	}

	const existingMetadata = existingByStableKey ? null : candidateByIdentity;
	const created = !(existingByStableKey ?? existingMetadata);
	const metadataValues = {
		stableKey,
		type,
		...toMetadataValues(results, providerName, matchScore),
	};
	let metadata = existingByStableKey ?? existingMetadata ?? undefined;
	metadata = await upsertMetadataRow(metadata, metadataValues, metadataWhere, tx);

	if (!metadata) throw new DomainError("internal", "Error while creating metadata", { code: "metadata.create_failed" });

	const metadataWithStableKey = metadata.stableKey ? metadata : { ...metadata, stableKey };
	const patch: { stableKey?: string; primaryProviderId?: string } = {};
	if (!metadata.stableKey) patch.stableKey = stableKey;

	if (!metadata.primaryProviderId) patch.primaryProviderId = providerName;

	if (hasEntry(patch)) {
		await metadataTable.update({ primaryId: metadata.id, values: patch, tx });
	}

	await linkProviders(metadata.id, type, links, tx);

	logger.info("Metadata linked to providers", {
		metadataId: metadata.id,
		providers: links.map((link) => link.name),
	});

	return { metadata: metadataWithStableKey, created };
}

export async function linkProviders(
	metadataId: string,
	type: "movie" | "tv_show",
	links: ReadonlyArray<{ name: string; externalId: string }>,
	tx?: DatabaseTransaction,
): Promise<void> {
	if (links.length === 0) return;

	const providers = await providersRepository.upsertByStableKey(
		links.map((link) => ({
			stableKey: createProviderStableKey({ providerName: link.name, entityType: type, externalId: link.externalId }),
			name: link.name,
			entityType: type,
			externalId: link.externalId,
		})),
		tx,
	);

	if (providers.length > 0) {
		await metadataProviders.insert({
			values: providers.map((provider) => ({ metadataId, providerId: provider.id })),
			tx,
		});
	}
}
