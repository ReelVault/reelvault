import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { upsertByStableKeyIdentity } from "@/integrations/drizzle-orm/query/upsert-by-identity.writer";
import { assertPresent } from "@/utils/domain.errors";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";

const { client } = useTestDatabase();

const genres = defineTableAccess("genres", { primaryKeyColumn: "id" });

describe("upsertByStableKeyIdentity", () => {
	test("repairs the stable key of a row that still carries the old natural identity", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "old", name: "Drama" });

		const row = await upsertByStableKeyIdentity(genres, {
			stableKey: "new",
			values: { stableKey: "new", name: "Drama" },
			identityWhere: eq(genres.table.name, "Drama"),
			reconcileValues: { stableKey: "new" },
		});

		assertPresent(row, "genre");
		expect(row.id).toBe("g1");
		expect(row.stableKey).toBe("new");

		const stored = await genres.selectFirstById({ primaryId: "g1" });
		expect(stored?.stableKey).toBe("new");
	});

	test("refuses a call without a natural-identity condition", async () => {
		await expect(
			upsertByStableKeyIdentity(genres, {
				stableKey: "new",
				values: { stableKey: "new", name: "Drama" },
				identityWhere: undefined,
				reconcileValues: { stableKey: "new" },
			}),
		).rejects.toMatchObject({ category: "internal", code: "table_access.identity_condition_missing" });
	});

	test("returns undefined when the conflict has no matching natural identity", async () => {
		await client().insert(schema.genres).values({ id: "g1", stableKey: "old", name: "Drama" });

		const row = await upsertByStableKeyIdentity(genres, {
			stableKey: "new",
			values: { stableKey: "new", name: "Drama" },
			identityWhere: eq(genres.table.name, "Missing"),
			reconcileValues: { stableKey: "new" },
		});

		expect(row).toBeUndefined();
		const stored = await genres.selectFirstById({ primaryId: "g1" });
		expect(stored?.stableKey).toBe("old");
	});
});
