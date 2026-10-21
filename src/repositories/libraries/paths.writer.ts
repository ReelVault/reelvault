import { resolve } from "node:path";
import type { CreateLibraryPath } from "@reelvault/sdk/common";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { toMap } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { libraryPaths } from "./shared.types";

/**
 * Replaces a library's paths with the given set: paths no longer listed are dropped, the rest are upserted.
 * A path already assigned to another library is refused rather than moved.
 */
export async function replacePaths(libraryId: string, paths: CreateLibraryPath[], tx?: DatabaseTransaction): Promise<void> {
	const normalizedPaths = [...toMap(paths, (item) => resolve(item.path.trim())).entries()];
	const client = databaseFactory.getClient({ tx });
	const stableKeys = normalizedPaths.map(([path]) => createLocalStableKey({ namespace: "library-path", value: path }));
	if (stableKeys.length === 0) {
		await libraryPaths.delete({ where: eq(schema.libraryPaths.libraryId, libraryId), tx });

		return;
	}

	await libraryPaths.delete({
		where: and(eq(schema.libraryPaths.libraryId, libraryId), notInArray(schema.libraryPaths.stableKey, stableKeys)),
		tx,
	});

	// The unique index on `path` makes a plain upsert silently re-parent the
	// existing row to THIS library, detaching it from the library that owned it.
	// A path shared between libraries is a caller error — reject it instead.
	const stolenRows = client
		.select({ id: schema.libraryPaths.id, path: schema.libraryPaths.path, libraryId: schema.libraryPaths.libraryId })
		.from(schema.libraryPaths)
		.where(and(inArray(schema.libraryPaths.stableKey, stableKeys), notInArray(schema.libraryPaths.libraryId, [libraryId])))
		.all();
	const stolen = stolenRows[0];
	if (stolen) {
		throw new DomainError("conflict", `Path ${stolen.path} is already assigned to another library`, { code: "library.path_conflict" });
	}

	await libraryPaths.upsert({
		values: normalizedPaths.map(([path, item]) => ({
			libraryId,
			path,
			metadataStorageMode: item.metadataStorageMode,
			stableKey: createLocalStableKey({ namespace: "library-path", value: path }),
		})),
		target: schema.libraryPaths.stableKey,
		set: {
			libraryId: sql`excluded.library_id`,
			path: sql`excluded.path`,
			metadataStorageMode: sql`excluded.metadata_storage_mode`,
			isActive: sql`excluded.is_active`,
			updatedAt: new Date(),
		},
	});
}
