import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { ScanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { schema } from "@/database/schema";

const client = databaseFactory.getClient();

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS scan_findings (
				library_id TEXT NOT NULL,
				file_path TEXT NOT NULL,
				file_name TEXT NOT NULL,
				reason TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				CONSTRAINT scan_findings_pk PRIMARY KEY (library_id, file_path)
			)
		`),
	);
});

beforeEach(async () => {
	await client.delete(schema.scanFindings);
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
});
