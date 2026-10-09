import { expect, test } from "bun:test";
import { createTestClient, jsonResponse } from "../helpers/sdk-client";

test("admin client reads the migration status", async () => {
	const requests: string[] = [];
	const client = createTestClient(
		(url) => {
			requests.push(url);

			return jsonResponse({ total: 3, applied: 2, pending: 1, latest: "b_add", migrations: [] });
		},
		{ enableRetry: false },
	);

	expect(await client.admin.getDatabaseMigrations()).toMatchObject({ applied: 2, pending: 1, latest: "b_add" });
	expect(requests).toEqual(["https://reelvault.test/v1/admin/database/migrations"]);
});
