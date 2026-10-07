import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory } from "./database";

const root = mkdtempSync(join(tmpdir(), "reelvault-pragmas-"));
const created: DatabaseFactory[] = [];

function createFactory(totalMemoryKiB: number): DatabaseFactory {
	const factory = new DatabaseFactory(join(root, `p-${totalMemoryKiB}.sqlite`), { totalMemoryKiB });
	created.push(factory);

	return factory;
}

function pragmaValue(factory: DatabaseFactory, name: string): number {
	const row = factory.sqlite.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
	const value = row ? Object.values(row)[0] : undefined;

	return typeof value === "number" ? value : Number(value);
}

afterAll(() => {
	for (const factory of created) factory.shutdown();

	rmSync(root, { recursive: true, force: true });
});

describe("database connection pragmas", () => {
	test("spills temp B-trees to disk and caps mmap on low-RAM hosts", () => {
		const factory = createFactory(1_024 * 1_024); // 1 GiB
		expect(pragmaValue(factory, "temp_store")).toBe(1); // 1 = FILE
		expect(pragmaValue(factory, "mmap_size")).toBe(67_108_864);
	});

	test("keeps in-memory temp store and full mmap on large hosts", () => {
		const factory = createFactory(32 * 1_024 * 1_024); // 32 GiB
		expect(pragmaValue(factory, "temp_store")).toBe(2); // 2 = MEMORY
		expect(pragmaValue(factory, "mmap_size")).toBe(268_435_456);
	});
});
