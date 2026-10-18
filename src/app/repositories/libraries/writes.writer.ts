import type { CreateLibrary, FieldsConfig, FieldsQuery, LibraryWithRelations, SelectFields, UpdateLibrary } from "@reelvault/sdk/common";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { hasEntry } from "@/utils/array.utils";
import { replacePaths } from "./paths.writer";
import { findById } from "./reads.reader";
import { clearStatsCaches, type LibraryStatsCaches, libraries } from "./shared.types";

export interface LibraryCreateParams<F extends string> {
	values: CreateLibrary;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}

export interface LibraryUpdateParams {
	primaryId: string;
	values: UpdateLibrary;
	tx?: DatabaseTransaction | undefined;
}

export async function createAndRead<F extends string>(caches: LibraryStatsCaches, body: CreateLibrary, query?: FieldsQuery<F>) {
	const { fields } = QueryUtils.parseStandard(query);

	return await create(caches, { values: body, fields });
}

export async function updateAndRead<F extends string>(
	caches: LibraryStatsCaches,
	libraryId: string,
	body: UpdateLibrary,
	query?: FieldsQuery<F>,
) {
	const { fields } = QueryUtils.parseStandard(query);
	await update(caches, { primaryId: libraryId, values: body });

	return await findById(caches, { primaryId: libraryId, fields });
}

export async function update(caches: LibraryStatsCaches, { primaryId, values, tx }: LibraryUpdateParams): Promise<void> {
	// Atomic: a path conflict / invalid path must not leave the library row
	// updated without its paths.
	await runInTransaction(tx, async (activeTx) => {
		const { paths, ...libraryValues } = values;
		if (hasEntry(libraryValues)) {
			await libraries.update({ primaryId, values: libraryValues, tx: activeTx });
		}

		if (paths !== undefined) {
			await replacePaths(primaryId, paths, activeTx);
		}
	});

	clearStatsCaches(caches);
}

/**
 * Create a new library. Returns undefined when a concurrent request won the
 * race and the (name, type) row already exists — the service turns that
 * into a 409 instead of pretending the caller created it.
 */
export async function create<F extends string>(
	caches: LibraryStatsCaches,
	{
		values: { name, type, metadataStorageMode = "database", sidecarFlavor = "reelvault", metadataLanguage = null, paths },
		fields,
		tx,
	}: LibraryCreateParams<F>,
): Promise<SelectFields<LibraryWithRelations, F> | undefined> {
	// Atomic: the library row and its paths must be created together.
	const result = await runInTransaction(tx, async (activeTx): Promise<SelectFields<LibraryWithRelations, F> | undefined> => {
		const [inserted] = await libraries.insertReturning({
			values: {
				name,
				type,
				metadataStorageMode,
				sidecarFlavor,
				metadataLanguage,
			},
			onConflict: "doNothing",
			tx: activeTx,
		});
		if (!inserted) return undefined;

		await replacePaths(inserted.id, paths, activeTx);

		return await findById(caches, {
			primaryId: inserted.id,
			fields,
			tx: activeTx,
		});
	});
	clearStatsCaches(caches);

	return result;
}
