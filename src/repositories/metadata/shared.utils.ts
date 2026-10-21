import type { FieldsConfig, ProviderEntityType } from "@reelvault/sdk/common";
import { and, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";

export const metadataCast = defineTableAccess("metadataCast", {
	primaryKeyColumn: "personId",
});
export const metadataCollections = defineTableAccess("metadataCollections", {
	primaryKeyColumn: "collectionId",
});
export const metadataCompanies = defineTableAccess("metadataCompanies", {
	primaryKeyColumn: "companyId",
});
export const metadataCrew = defineTableAccess("metadataCrew", {
	primaryKeyColumn: "personId",
});
export const metadataGenres = defineTableAccess("metadataGenres", {
	primaryKeyColumn: "genreId",
});
export const metadataImages = defineTableAccess("metadataImages", {
	primaryKeyColumn: "imageId",
});
export const metadataKeywords = defineTableAccess("metadataKeywords", {
	primaryKeyColumn: "keywordId",
});
export const metadataProviders = defineTableAccess("metadataProviders", {
	primaryKeyColumn: "providerId",
});
export const metadataRatings = defineTableAccess("metadataRatings", {
	primaryKeyColumn: "metadataId",
});

export async function findMetadataProvider({
	providerId,
	externalId,
	name,
	entityType,
	tx,
}: {
	providerId?: string | undefined;
	externalId?: string | undefined;
	name?: string | undefined;
	entityType?: ProviderEntityType | undefined;
	tx?: DatabaseTransaction | undefined;
}) {
	const client = databaseFactory.getClient({ tx });
	let where: SQL | undefined;
	if (providerId) {
		where = eq(metadataProviders.table.providerId, providerId);
	} else if (externalId && name && entityType) {
		where = and(eq(schema.providers.externalId, externalId), eq(schema.providers.name, name), eq(schema.providers.entityType, entityType));
	}

	if (!where)
		throw new DomainError("validation", "Metadata provider lookup requires a provider ID or a complete external identity", {
			code: "metadata_provider_lookup_requires",
		});

	const [existingLink] = await client
		.select({ metadata: schema.metadata })
		.from(schema.metadata)
		.innerJoin(metadataProviders.table, eq(metadataProviders.table.metadataId, schema.metadata.id))
		.innerJoin(schema.providers, eq(metadataProviders.table.providerId, schema.providers.id))
		.where(where)
		.limit(1);

	return existingLink;
}

/** Falls back to the primary provider when no explicit link list is supplied, and de-duplicates by (name, externalId). */
export function normalizeProviderLinks(
	primaryProviderName: string,
	primaryExternalId: string,
	providers?: ReadonlyArray<{ name: string; externalId: string }>,
): Array<{ name: string; externalId: string }> {
	const source = providers && providers.length > 0 ? providers : [{ name: primaryProviderName, externalId: primaryExternalId }];
	const seen = new Set<string>();
	const links: Array<{ name: string; externalId: string }> = [];
	for (const provider of source) {
		const key = `${provider.name}\u0000${provider.externalId}`;
		if (seen.has(key)) continue;

		seen.add(key);
		links.push({ name: provider.name, externalId: provider.externalId });
	}

	return links;
}

export const metadataTable = defineTableAccess("metadata", {
	primaryKeyColumn: "id",
});

export const metadataColumns = getTableColumns(schema.metadata);

// Fixed-shape PK read for hot paths (Faza 3 pilot): one prepared query per
// connection, reused across calls.
export const preparedFindRootsById = createPreparedQuery((client) =>
	client
		.select()
		.from(schema.metadata)
		.where(eq(schema.metadata.id, sql.placeholder("id")))
		.limit(1)
		.prepare(),
);

/** Args shared by the private selectMetadata and the public findMany/findManyWithCursor. */
export interface MetadataSelectArgs<F extends string> {
	fields?: FieldsConfig<F> | undefined;
	where?: SQL | undefined;
	orderBy?: SQL | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
	requiredFields?: Array<keyof typeof metadataColumns> | undefined;
	tx?: DatabaseTransaction | undefined;
}

/** Flat metadata row (no relations) — the DTO returned by `findRootsById`. */
export type MetadataRootRow = typeof schema.metadata.$inferSelect;

export const logger = createLogger("MetadataRepository");
