import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRepositoriesRepository } from "@/repositories/plugin-repositories.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { waitFor } from "../../../tests/helpers/wait.helper";
import { pluginCatalogService } from "./plugin-catalog.service";

// Repositories, their order and the install status run against the migrated test database.
// Stubbed: `fetchManifest`, the network read of one repository's manifest, and
// `getInstalledRecords`, the install state read from the plugin directory.
const db = useTestDatabase();

const sha = (digit: string): string => `sha256-${digit.repeat(64)}`;

const FLOORED_ENTRY = {
	id: "org.reelvault.gated",
	name: "Gated Plugin",
	version: "2.0.0",
	category: "other",
	minServerVersion: "9.9.9",
	// A host that never resolves: a broken gate fails fast instead of downloading anything.
	downloadUrl: "https://plugins.invalid/gated-2.0.0.zip",
	checksum: sha("0"),
};

const activeStubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
	activeStubs.length = 0;
});

/** Creates a repository; `list` sorts by creation time, so each one gets its own timestamp from `index`. */
async function seedRepository(name: string, index: number, enabled = true): Promise<string> {
	const row = await pluginRepositoriesRepository.create({ name, url: `https://example.com/${name}.json`, enabled });
	await db
		.client()
		.update(schema.pluginRepositories)
		.set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) })
		.where(eq(schema.pluginRepositories.id, row.id));

	return row.id;
}

function catalogEntry(id: string, version: string) {
	return { id, name: id, version, category: "other" };
}

function installedRecord(id: string, version: string, pinned = false) {
	return {
		id,
		record: { directory: `/plugins/${id}`, integrity: sha("1"), installedAt: "2026-01-01T00:00:00.000Z", source: "test", version, pinned },
	};
}

describe("pluginCatalogService.installFromCatalog min-server-version gate", () => {
	test("refuses an install that needs a newer server before any download starts", async () => {
		const repositoryId = await seedRepository("repo-1", 0);
		activeStubs.push(
			stubMethod(pluginCatalogService, "fetchManifest", () =>
				Promise.resolve({ manifest: { apiVersion: 1, name: "Test", plugins: [FLOORED_ENTRY] }, fetchedAt: Date.now() }),
			),
		);

		await expect(pluginCatalogService.installFromCatalog({ repositoryId, pluginId: "org.reelvault.gated" })).rejects.toMatchObject({
			category: "validation",
			code: "plugin.server_too_old",
		});
	});
});

describe("pluginCatalogService.getCatalog", () => {
	test("fetches enabled repository manifests concurrently and keeps repository order", async () => {
		await seedRepository("repo-a", 0);
		await seedRepository("repo-b", 1);
		await seedRepository("repo-c", 2);
		await seedRepository("repo-off", 3, false);
		let inFlight = 0;
		let maxInFlight = 0;
		const fetched: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		activeStubs.push(
			stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])),
			stubMethod(pluginCatalogService, "fetchManifest", async (row: { name: string }) => {
				fetched.push(row.name);
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await gate;
				inFlight--;

				return {
					manifest: { apiVersion: 1, name: row.name, plugins: [catalogEntry(`plugin-${row.name}`, "1.0.0")] },
					fetchedAt: Date.now(),
				};
			}),
		);

		const catalog = pluginCatalogService.getCatalog();
		// Each manifest is held until all three are in flight together, so a serial or limited fetch never gets there.
		await waitFor(() => inFlight === 3);
		release();
		const { plugins } = await catalog;

		expect(plugins.map((entry) => entry.id)).toEqual(["plugin-repo-a", "plugin-repo-b", "plugin-repo-c"]);
		// Serial fetching would peak at one in-flight manifest. The disabled repository is never fetched.
		expect(maxInFlight).toBe(3);
		expect(fetched.toSorted((a, b) => a.localeCompare(b))).toEqual(["repo-a", "repo-b", "repo-c"]);
	});

	test("reports a repository it cannot read by code, and keeps the others", async () => {
		await seedRepository("repo-ok", 0);
		const downId = await seedRepository("repo-down", 1);

		activeStubs.push(
			stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])),
			stubMethod(pluginCatalogService, "fetchManifest", (row: { name: string }) =>
				row.name === "repo-down"
					? Promise.reject(new Error("connection refused"))
					: Promise.resolve({
							manifest: { apiVersion: 1, name: row.name, plugins: [catalogEntry("plugin-ok", "1.0.0")] },
							fetchedAt: Date.now(),
						}),
			),
		);

		const catalog = await pluginCatalogService.getCatalog();

		expect(catalog.plugins.map((entry) => entry.id)).toEqual(["plugin-ok"]);
		expect(catalog.unavailableRepositories).toEqual([
			{ repositoryId: downId, repositoryName: "repo-down", errorCode: "plugin.repository_unavailable" },
		]);
	});
});

describe("pluginCatalogService.updatablePluginIds", () => {
	test("lists only the plugins that an enabled repository offers in a newer version", async () => {
		await seedRepository("repo-main", 0);
		activeStubs.push(
			stubMethod(pluginManager, "getInstalledRecords", () =>
				Promise.resolve([
					installedRecord("org.reelvault.newer", "1.0.0"),
					installedRecord("org.reelvault.current", "1.0.0"),
					installedRecord("org.reelvault.pinned", "1.0.0", true),
				]),
			),
			stubMethod(pluginCatalogService, "fetchManifest", () =>
				Promise.resolve({
					manifest: {
						apiVersion: 1,
						name: "Main",
						plugins: [
							catalogEntry("org.reelvault.newer", "2.0.0"),
							catalogEntry("org.reelvault.current", "1.0.0"),
							catalogEntry("org.reelvault.pinned", "2.0.0"),
							catalogEntry("org.reelvault.fresh", "1.0.0"),
						],
					},
					fetchedAt: Date.now(),
				}),
			),
		);

		// A pinned plugin keeps its installed version, so it is never offered as an update.
		await expect(pluginCatalogService.updatablePluginIds()).resolves.toEqual(new Set(["org.reelvault.newer"]));
	});

	test("offers no update when the repository cannot be read", async () => {
		await seedRepository("repo-main", 0);
		activeStubs.push(
			stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([installedRecord("org.reelvault.newer", "1.0.0")])),
			stubMethod(pluginCatalogService, "fetchManifest", () => Promise.reject(new Error("offline"))),
		);

		await expect(pluginCatalogService.updatablePluginIds()).resolves.toEqual(new Set());
	});
});
