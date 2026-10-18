import { beforeEach, describe, expect, test } from "bun:test";
import { ScanFindingsRepository } from "@/app/repositories/scan-findings.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";

useTestDatabase();

beforeEach(async () => {
	await databaseFactory
		.getClient()
		.insert(schema.libraries)
		.values([
			{ id: "lib-1", name: "Library One", type: "movies" },
			{ id: "lib-2", name: "Library Two", type: "movies" },
		]);
});

function createRepository(): ScanFindingsRepository {
	return new ScanFindingsRepository(databaseFactory);
}

describe("scanFindingsRepository", () => {
	test("upsert inserts a finding and updates it on conflict without duplicating rows", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "recognition_failed" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "no_metadata_match" });

		expect(await repository.list("lib-1")).toEqual([{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "no_metadata_match" }]);
	});

	test("list returns only the given library ordered by path", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/c.mkv", fileName: "c.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-2", filePath: "/media2/b.mkv", fileName: "b.mkv", reason: "type_mismatch" });

		expect(await repository.list("lib-1")).toEqual([
			{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" },
			{ filePath: "/media/c.mkv", fileName: "c.mkv", reason: "type_mismatch" },
		]);
		expect(await repository.list("lib-2")).toHaveLength(1);
	});

	test("remove deletes only the finding for the given path", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/b.mkv", fileName: "b.mkv", reason: "type_mismatch" });

		await repository.remove("lib-1", "/media/a.mkv");

		expect(await repository.list("lib-1")).toEqual([{ filePath: "/media/b.mkv", fileName: "b.mkv", reason: "type_mismatch" }]);
	});

	test("removeMany deletes the listed paths in one library and keeps the same paths in another", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/b.mkv", fileName: "b.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/c.mkv", fileName: "c.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-2", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });

		await repository.removeMany("lib-1", ["/media/a.mkv", "/media/b.mkv"]);

		expect(await repository.list("lib-1")).toEqual([{ filePath: "/media/c.mkv", fileName: "c.mkv", reason: "type_mismatch" }]);
		expect(await repository.list("lib-2")).toEqual([{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }]);
	});

	test("pruneStale bulk-deletes stale findings inside scanned roots only", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/b.mkv", fileName: "b.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/other/c.mkv", fileName: "c.mkv", reason: "type_mismatch" });

		await repository.pruneStale("lib-1", ["/media/a.mkv"], ["/media"]);

		expect(await repository.list("lib-1")).toEqual([
			{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" },
			{ filePath: "/other/c.mkv", fileName: "c.mkv", reason: "type_mismatch" },
		]);
	});

	test("list filters by status", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/b.mkv", fileName: "b.mkv", reason: "no_metadata_match" });
		await repository.setIgnored("lib-1", "/media/b.mkv", true);

		expect(await repository.list("lib-1", "active")).toEqual([{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }]);
		expect(await repository.list("lib-1", "ignored")).toEqual([
			{ filePath: "/media/b.mkv", fileName: "b.mkv", reason: "no_metadata_match" },
		]);
		expect(await repository.list("lib-1")).toHaveLength(2);
	});

	test("a rescan keeps a finding ignored, and restoring it returns it to the active list", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		expect(await repository.setIgnored("lib-1", "/media/a.mkv", true)).toBe(true);

		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "no_metadata_match" });

		expect(await repository.list("lib-1", "active")).toEqual([]);
		expect(await repository.list("lib-1", "ignored")).toEqual([
			{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "no_metadata_match" },
		]);

		expect(await repository.setIgnored("lib-1", "/media/a.mkv", false)).toBe(true);
		expect(await repository.list("lib-1", "active")).toHaveLength(1);
		expect(await repository.list("lib-1", "ignored")).toEqual([]);
	});

	test("setIgnored and findByPath report a missing finding", async () => {
		const repository = createRepository();

		expect(await repository.setIgnored("lib-1", "/media/missing.mkv", true)).toBe(false);
		expect(await repository.findByPath("lib-1", "/media/missing.mkv")).toBeNull();

		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "probe_failed" });
		expect(await repository.findByPath("lib-1", "/media/a.mkv")).toEqual({
			filePath: "/media/a.mkv",
			fileName: "a.mkv",
			reason: "probe_failed",
		});
	});

	test("pruneStale also drops an ignored finding whose file is gone", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.setIgnored("lib-1", "/media/a.mkv", true);

		await repository.pruneStale("lib-1", [], ["/media"]);

		expect(repository.listWithCounts("lib-1").counts).toEqual({ active: 0, ignored: 0 });
	});
});

describe("scanFindingsRepository.listWithCounts", () => {
	test("returns the filtered findings with both status counts", async () => {
		const repository = createRepository();
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" });
		await repository.upsert({ libraryId: "lib-1", filePath: "/media/b.mkv", fileName: "b.mkv", reason: "no_metadata_match" });
		await repository.setIgnored("lib-1", "/media/b.mkv", true);

		expect(repository.listWithCounts("lib-1", "active")).toEqual({
			items: [{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" }],
			counts: { active: 1, ignored: 1 },
		});
		expect(repository.listWithCounts("lib-1", "ignored")).toEqual({
			items: [{ filePath: "/media/b.mkv", fileName: "b.mkv", reason: "no_metadata_match" }],
			counts: { active: 1, ignored: 1 },
		});
		expect(repository.listWithCounts("lib-1")).toEqual({
			items: [
				{ filePath: "/media/a.mkv", fileName: "a.mkv", reason: "type_mismatch" },
				{ filePath: "/media/b.mkv", fileName: "b.mkv", reason: "no_metadata_match" },
			],
			counts: { active: 1, ignored: 1 },
		});
		expect(repository.listWithCounts("lib-2").counts).toEqual({ active: 0, ignored: 0 });
	});
});
