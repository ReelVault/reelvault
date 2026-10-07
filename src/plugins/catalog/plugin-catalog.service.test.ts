import { afterEach, describe, expect, test } from "bun:test";
import { pluginRepositoriesRepository } from "@/database/repositories/plugin-repositories.repository";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub";
import { pluginCatalogService } from "./plugin-catalog.service";

const sha = (digit: string): string => `sha256-${digit.repeat(64)}`;

const FLOORED_ENTRY = {
	id: "org.reelvault.gated",
	name: "Gated Plugin",
	version: "2.0.0",
	category: "other",
	minServerVersion: "9.9.9",
	downloadUrl: "https://example.com/gated-2.0.0.zip",
	checksum: sha("0"),
};

describe("pluginCatalogService.installFromCatalog min-server-version gate", () => {
	const activeStubs: MethodStub[] = [];

	afterEach(() => {
		for (const stub of activeStubs.toReversed()) stub.restore();
		activeStubs.length = 0;
	});

	test("refuses the install with plugin.server_too_old before downloading anything", async () => {
		activeStubs.push(
			stubMethod(pluginRepositoriesRepository, "findById", async () => ({
				id: "repo-1",
				name: "Test Repo",
				url: "https://example.com/catalog.json",
				enabled: true,
				tokenEncrypted: null,
				lastRefreshedAt: null,
				lastError: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
			stubMethod(pluginCatalogService, "fetchManifest", async () => ({
				manifest: { apiVersion: 1, name: "Test", plugins: [FLOORED_ENTRY] },
				fetchedAt: Date.now(),
			})),
		);

		let downloadCalled = false;
		activeStubs.push(
			stubMethod(pluginManager, "getInstalledRecords", async () => []),
			stubMethod(pluginManager, "installFromDirectory", () => {
				downloadCalled = true;

				return Promise.reject(new Error("install must not run"));
			}),
		);

		let caught: unknown;
		try {
			await pluginCatalogService.installFromCatalog({ repositoryId: "repo-1", pluginId: "org.reelvault.gated" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as { code?: string }).code).toBe("plugin.server_too_old");
		expect((caught as Error).message).toContain("9.9.9");
		expect(downloadCalled).toBe(false);
	});
});

describe("pluginCatalogService.getCatalog", () => {
	const activeStubs: MethodStub[] = [];

	afterEach(() => {
		for (const stub of activeStubs.toReversed()) stub.restore();
		activeStubs.length = 0;
	});

	test("fetches enabled repository manifests concurrently and keeps repository order", async () => {
		const rows = ["repo-a", "repo-b", "repo-c"].map((id, index) => ({
			id,
			name: `Repo ${index}`,
			url: `https://example.com/${id}.json`,
			enabled: true,
			tokenEncrypted: null,
			lastRefreshedAt: null,
			lastError: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		}));
		let inFlight = 0;
		let maxInFlight = 0;

		activeStubs.push(
			stubMethod(pluginRepositoriesRepository, "count", () => Promise.resolve(rows.length)),
			stubMethod(pluginRepositoriesRepository, "list", () => Promise.resolve(rows)),
			stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])),
			stubMethod(pluginCatalogService, "fetchManifest", async (row: { id: string }) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => {
					setTimeout(resolve, 25);
				});
				inFlight--;

				return {
					manifest: {
						apiVersion: 1,
						name: row.id,
						plugins: [{ id: `plugin-${row.id}`, name: "Plugin", version: "1.0.0", category: "other" }],
					},
					fetchedAt: Date.now(),
				};
			}),
		);

		const entries = await pluginCatalogService.getCatalog();

		expect(entries.map((entry) => entry.id)).toEqual(["plugin-repo-a", "plugin-repo-b", "plugin-repo-c"]);
		// Serial fetching would peak at one in-flight manifest.
		expect(maxInFlight).toBe(3);
	});
});
