import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginRepositoriesRepository } from "@/repositories/plugin-repositories.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../tests/helpers/module-mock.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginCatalogService } from "./plugin-catalog.service";

// The network reads that feed `fetchManifest` and the archive download are mocked;
// repository state and the catalog service's cache run for real.
type FetchImpl = (url: string) => Promise<Response>;
let fetchImpl: FetchImpl = async () => new Response();
mockModuleWithRealExports("@/utils/url-guard.utils", {
	guardedFetch: (url: string) => fetchImpl(url),
});

interface FakeDownload {
	directory: string;
	filePath: string;
	checksum: string;
	size: number;
	cleanup(): Promise<void>;
}
let downloadImpl: () => Promise<FakeDownload> = async () => ({
	directory: "",
	filePath: "",
	checksum: "",
	size: 0,
	cleanup: () => Promise.resolve(),
});
mockModuleWithRealExports("@/plugins/catalog/plugin-package/download.fetcher", {
	downloadArchive: () => downloadImpl(),
});

afterAll(() => restoreModuleMocks());

useTestDatabase();

const sha = (digit: string): string => `sha256-${digit.repeat(64)}`;

function manifestEntry(id: string) {
	return {
		id,
		name: id,
		version: "1.0.0",
		category: "other",
		downloadUrl: "https://example.com/pkg.bin",
		checksum: sha("0"),
	};
}

const activeStubs: MethodStub[] = [];

beforeEach(() => {
	fetchImpl = async () => new Response();
	downloadImpl = async () => ({
		directory: "",
		filePath: "",
		checksum: "",
		size: 0,
		cleanup: () => Promise.resolve(),
	});
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
	activeStubs.length = 0;
});

describe("pluginCatalogService manifest cache", () => {
	test("reuses a cached manifest until the 15-minute freshness window closes", async () => {
		await pluginRepositoriesRepository.create({ name: "repo-ttl", url: "https://example.com/ttl.json" });
		activeStubs.push(stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])));
		let fetches = 0;
		fetchImpl = () => {
			fetches++;

			return Promise.resolve(new Response(JSON.stringify({ apiVersion: 1, name: "Test", plugins: [manifestEntry(`plugin-${fetches}`)] })));
		};
		let now = 1_000_000;
		activeStubs.push(stubMethod(Date, "now", () => now));

		const first = await pluginCatalogService.getCatalog();
		expect(first.plugins.map((entry) => entry.id)).toEqual(["plugin-1"]);

		now += 14 * 60_000;
		const withinWindow = await pluginCatalogService.getCatalog();
		expect(withinWindow.plugins.map((entry) => entry.id)).toEqual(["plugin-1"]);

		now += 60_000;
		const atWindow = await pluginCatalogService.getCatalog();
		expect(atWindow.plugins.map((entry) => entry.id)).toEqual(["plugin-2"]);
	});

	test("invalidates the cached manifest when the URL and token change", async () => {
		const row = await pluginRepositoriesRepository.create({ name: "repo-cache", url: "https://example.com/first.json" });
		activeStubs.push(stubMethod(pluginManager, "getInstalledRecords", () => Promise.resolve([])));
		fetchImpl = async (url) =>
			new Response(
				JSON.stringify({
					apiVersion: 1,
					name: "Test",
					plugins: [manifestEntry(url.includes("second") ? "plugin-second" : "plugin-first")],
				}),
			);

		const first = await pluginCatalogService.getCatalog();
		expect(first.plugins.map((entry) => entry.id)).toEqual(["plugin-first"]);

		await pluginCatalogService.updateRepository(row.id, { url: "https://example.com/second.json", token: "secret" });

		const second = await pluginCatalogService.getCatalog();
		expect(second.plugins.map((entry) => entry.id)).toEqual(["plugin-second"]);
	});
});

describe("pluginCatalogService catalog refresh", () => {
	test("reports a failed manifest fetch with its HTTP status", async () => {
		const row = await pluginRepositoriesRepository.create({ name: "repo-fail", url: "https://example.com/fail.json" });
		fetchImpl = async () => new Response("unavailable", { status: 503 });

		await expect(pluginCatalogService.refreshRepository(row.id)).rejects.toMatchObject({
			category: "validation",
			code: "plugin.repository_fetch_failed",
			params: { status: 503 },
		});
	});

	test("removes the downloaded archive when the checksum does not match", async () => {
		const row = await pluginRepositoriesRepository.create({ name: "repo-cleanup", url: "https://example.com/cleanup.json" });
		let cleaned = false;
		downloadImpl = async () => ({
			directory: "/nonexistent/staging",
			filePath: "/nonexistent/staging/package.bin",
			checksum: sha("1"),
			size: 0,
			cleanup: () => {
				cleaned = true;

				return Promise.resolve();
			},
		});
		activeStubs.push(
			stubMethod(pluginCatalogService, "fetchManifest", () =>
				Promise.resolve({
					manifest: { apiVersion: 1, name: "Test", plugins: [manifestEntry("org.example.checked")] },
					fetchedAt: Date.now(),
				}),
			),
		);

		await expect(pluginCatalogService.installFromCatalog({ repositoryId: row.id, pluginId: "org.example.checked" })).rejects.toMatchObject({
			code: "plugin.checksum_mismatch",
		});
		expect(cleaned).toBe(true);
	});
});
