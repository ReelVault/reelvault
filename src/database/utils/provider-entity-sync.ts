import type { ProviderEntityType } from "@sdk/common/provider.types";
import { and, eq, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { forEachChunked, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { toMap } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger";
import { providersRepository } from "../repositories/providers.repository";
import { createLocalStableKey, createProviderStableKey } from "./stable-key";

export interface NamedProviderEntity {
	id: string;
	name: string;
}

export interface EntityRow {
	id: string;
	stableKey: string;
	name: string;
}

export interface ProviderEntityAssociation<T extends NamedProviderEntity> {
	input: T;
	entityId: string;
	providerId?: string | undefined;
}

export async function syncNamedProviderEntities<T extends NamedProviderEntity>({
	items,
	providerName,
	entityType,
	tx,
	insertEntities,
	selectEntities,
	persistAssociations,
}: {
	items: T[];
	providerName: string;
	entityType: ProviderEntityType;
	tx?: DatabaseTransaction | undefined;
	insertEntities: (items: Array<{ name: string; stableKey: string }>) => Promise<void>;
	selectEntities: (names: string[]) => Promise<EntityRow[]>;
	persistAssociations: (associations: Array<ProviderEntityAssociation<T>>) => Promise<void>;
}): Promise<void> {
	if (items.length === 0) return;

	const uniqueProviderItems = [...toMap(items, (item) => item.id).values()];
	const externalIds = uniqueProviderItems.map((item) => item.id);

	const entityMap = new Map<string, { name: string; stableKey: string }>();
	for (const item of uniqueProviderItems) {
		const name = item.name.trim();
		if (!name) continue;

		if (!entityMap.has(name)) {
			const stableKey = createLocalStableKey({ namespace: entityType, value: name });
			entityMap.set(name, { name, stableKey });
		}
	}

	const entityItems = [...entityMap.values()];
	if (entityItems.length === 0) return;

	const names = entityItems.map((item) => item.name);

	await Promise.all([
		insertEntities(entityItems),
		providersRepository.upsertByStableKey(
			externalIds.map((externalId) => ({
				stableKey: createProviderStableKey({ providerName, entityType, externalId }),
				name: providerName,
				entityType,
				externalId,
			})),
			tx,
		),
	]);

	// Chunk the lookups: a title's full cast/crew can exceed SQLite's bound-variable
	// limit, and one giant statement blocks the event loop longer than needed.
	const selectAllEntities = async (): Promise<EntityRow[]> => mapChunked(names, (nameChunk) => selectEntities(nameChunk));
	const selectAllProviders = async (): Promise<Array<typeof providersRepository.table.$inferSelect>> =>
		mapChunked(externalIds, (idChunk) =>
			providersRepository.selectMany({
				where: and(
					eq(providersRepository.table.name, providerName),
					eq(providersRepository.table.entityType, entityType),
					inArray(providersRepository.table.externalId, idChunk),
				),
				tx,
			}),
		);

	const [entities, providers] = await Promise.all([selectAllEntities(), selectAllProviders()]);
	const entityIds = toMap(
		entities,
		(entity) => entity.name,
		(entity) => entity.id,
	);
	const providerIds = toMap(
		providers,
		(provider) => provider.externalId,
		(provider) => provider.id,
	);

	const seenAssociations = new Set<string>();
	const associations: Array<ProviderEntityAssociation<T>> = [];
	for (const input of items) {
		const name = input.name.trim();
		if (!name) continue;

		const entityId = entityIds.get(name);
		if (!entityId) continue;

		const providerId = providerIds.get(input.id);
		const key = `${entityId}:${providerId ?? ""}`;
		if (!seenAssociations.has(key)) {
			seenAssociations.add(key);
			associations.push({ input, entityId, providerId });
		}
	}

	await persistAssociations(associations);
}

/**
 * Shared upsert for named provider entities (genres, keywords, companies, collections).
 * Inserts rows with `onConflictDoUpdate` touching only `updatedAt`.
 */
export async function upsertNamedEntities(
	table: SQLiteTable & { name: SQLiteColumn },
	items: Array<{ name: string; stableKey: string }>,
	tx?: DatabaseTransaction,
): Promise<void> {
	if (items.length === 0) return;

	await forEachChunked(items, (values) =>
		databaseFactory
			.getClient({ tx })
			.insert(table)
			.values(values)
			.onConflictDoUpdate({ target: table.name, set: { updatedAt: new Date() } }),
	);
}

/**
 * Wraps syncNamedProviderEntities with the standard guard + error-logging
 * pattern used by genres, keywords, and companies repositories.
 */
export async function processNamedEntities<T extends NamedProviderEntity>({
	items,
	providerName,
	entityType,
	entityLabel,
	tx,
	insertEntities,
	selectEntities,
	persistAssociations,
}: {
	items: T[] | undefined;
	providerName: string;
	entityType: ProviderEntityType;
	entityLabel: string;
	tx?: DatabaseTransaction | undefined;
	insertEntities: (items: Array<{ name: string; stableKey: string }>) => Promise<void>;
	selectEntities: (names: string[]) => Promise<EntityRow[]>;
	persistAssociations: (associations: Array<ProviderEntityAssociation<T>>) => Promise<void>;
}): Promise<void> {
	const logger = createLogger("processNamedEntities");
	if (!items?.length) {
		logger.debug(`No ${entityLabel} to process`);

		return;
	}

	try {
		await syncNamedProviderEntities({
			items,
			providerName,
			entityType,
			tx,
			insertEntities,
			selectEntities,
			persistAssociations,
		});
	} catch (error) {
		logger.error(`Failed to process ${entityLabel}`, error);
		throw error;
	}
}
