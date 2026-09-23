import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstalledPluginRecord, PluginLockfileStore } from "./lockfile.store";

const temporaryDirectories: string[] = [];

function createRecord(directory: string): InstalledPluginRecord {
	return {
		directory,
		integrity: "sha256-abc",
		installedAt: "2026-09-20T00:00:00.000Z",
		source: "fixture",
		version: "1.0.0",
	};
}

describe("PluginLockfileStore", () => {
	let pluginsDirectory: string;
	let store: PluginLockfileStore;

	beforeEach(async () => {
		pluginsDirectory = await mkdtemp(join(tmpdir(), "reelvault-lockfile-"));
		temporaryDirectories.push(pluginsDirectory);
		store = new PluginLockfileStore(pluginsDirectory);
	});

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
	});

	test("reading a missing lockfile yields an empty registry", async () => {
		await expect(store.read()).resolves.toEqual({ version: 1, plugins: {} });
	});

	test("write and read round-trip records atomically without temp leftovers", async () => {
		await store.write({ version: 1, plugins: { "org.reelvault.a": createRecord("org.reelvault.a") } });

		await expect(store.read()).resolves.toEqual({
			version: 1,
			plugins: { "org.reelvault.a": createRecord("org.reelvault.a") },
		});
		const leftovers = await Array.fromAsync(new Bun.Glob("*.tmp*").scan({ cwd: pluginsDirectory }));
		expect(leftovers).toEqual([]);
	});

	test("writeRecord appends and refuses to overwrite without replace", async () => {
		await store.writeRecord("org.reelvault.a", createRecord("org.reelvault.a"), { replace: false });

		await expect(store.writeRecord("org.reelvault.a", createRecord("org.reelvault.a"), { replace: false })).rejects.toThrow(
			"already exists in plugins.lock.json",
		);

		const upgraded = { ...createRecord("org.reelvault.a"), version: "2.0.0" };
		await store.writeRecord("org.reelvault.a", upgraded, { replace: true });
		await expect(store.read()).resolves.toMatchObject({ plugins: { "org.reelvault.a": { version: "2.0.0" } } });
	});

	test("rejects a corrupt lockfile instead of starting fresh", async () => {
		await writeFile(join(pluginsDirectory, "plugins.lock.json"), '{"version":1,"plugins":"nope"}');

		await expect(store.read()).rejects.toThrow("Invalid plugins.lock.json");
	});

	test("resolveInstalledDirectory rejects a directory entry that does not equal the plugin id", () => {
		expect(() => store.resolveInstalledDirectory("../escape", createRecord("../escape"))).toThrow(
			"unsafe plugins.lock.json directory entry",
		);
		expect(() => store.resolveInstalledDirectory("org.reelvault.a", createRecord("other-dir"))).toThrow(
			"unsafe plugins.lock.json directory entry",
		);
		expect(() => store.resolveInstalledDirectory("nested/path", createRecord("nested/path"))).toThrow(
			"unsafe plugins.lock.json directory entry",
		);
	});

	test("resolveInstalledDirectory returns the absolute package path for a valid record", () => {
		expect(store.resolveInstalledDirectory("org.reelvault.a", createRecord("org.reelvault.a"))).toBe(
			join(pluginsDirectory, "org.reelvault.a"),
		);
	});
});
