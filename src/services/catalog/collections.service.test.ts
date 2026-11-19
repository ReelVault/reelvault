import { describe, expect, test } from "bun:test";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { collectionsService } from "./collections.service";

useTestDatabase();

describe("collectionsService.create", () => {
	test("stores a collection name without the surrounding spaces", async () => {
		const created = await collectionsService.create({ name: "  Favorites  " });

		expect(created.name).toBe("Favorites");
	});

	test("refuses a blank collection name with its validation code", async () => {
		await expect(collectionsService.create({ name: "   " })).rejects.toMatchObject({
			category: "validation",
			code: "collections.name_required",
		});
	});
});
