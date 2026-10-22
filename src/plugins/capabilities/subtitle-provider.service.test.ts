import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest, PluginRuntime, ReelVaultPlugin, SubtitleProvider } from "@reelvault/sdk/plugin";
import { eq } from "drizzle-orm";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { subtitleProviderSettingsRepository } from "@/repositories/subtitle-provider-settings.repository";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { subtitleProviderService } from "./subtitle-provider.service";

// Media, metadata, subtitle rows and provider switches run against the migrated test database, and
// the stored subtitle files are real files in the core subtitle directory. The providers are plain
// objects registered the way the plugin loader registers them: their search and download functions
// stand in for the external services, and nothing else is faked.
const db = useTestDatabase();
const PLUGIN_ID = "org.reelvault.subtitles";
const manifest: PluginManifest = { id: PLUGIN_ID, name: "Subtitles plugin", version: "1.0.0", entry: "./dist/index.js", capabilities: [] };
const plugin: ReelVaultPlugin = { setup: async () => undefined };
const generatedPaths: string[] = [];
let mediaFileId = "";

beforeEach(async () => {
	mediaFileId = await insertMovieMediaFile(db.client(), "/media/Example Movie (2024)/example.mkv", "metadata-1");
	await db
		.client()
		.update(schema.metadata)
		.set({ title: "Example Movie", releaseDate: "2024-01-01" })
		.where(eq(schema.metadata.id, "metadata-1"));
});

afterEach(async () => {
	pluginRegistry.clear();
	await Promise.all(generatedPaths.splice(0).map(async (path) => await rm(path, { force: true })));
});

function createProvider(
	id: string,
	search: SubtitleProvider["search"],
	download: SubtitleProvider["download"] = async () => null,
): SubtitleProvider {
	return {
		id,
		name: id,
		version: "1.0.0",
		initialize: async () => undefined,
		search,
		download,
	};
}

/** Registers the plugin and its providers, then enables the plugin, as the plugin loader does. */
function registerProviders(providers: SubtitleProvider[]): void {
	const runtime: PluginRuntime = {
		manifest,
		plugin,
		state: "discovered",
		providerIds: [],
		subtitleProviderIds: providers.map((provider) => provider.id),
		analyzerIds: [],
		jobNames: [],
	};
	pluginRegistry.register(runtime, [], [], providers);
	pluginRegistry.enable(PLUGIN_ID);
}

async function storedSubtitles() {
	return await db.client().select().from(schema.subtitles);
}

describe("subtitle provider search", () => {
	test("passes the title to healthy providers and isolates a provider that fails", async () => {
		registerProviders([
			createProvider("healthy", async ({ media, languages }) => [
				{ id: "candidate-1", language: languages?.[0] ?? "en", label: media.title, format: "vtt" },
			]),
			createProvider("broken", () => Promise.reject(new Error("Provider unavailable"))),
		]);

		await expect(subtitleProviderService.search({ mediaFileId, languages: ["pl"] })).resolves.toEqual([
			{ providerId: "healthy", results: [{ id: "candidate-1", language: "pl", label: "Example Movie", format: "vtt" }] },
		]);
	});

	test("limits concurrent provider searches to the configured concurrency", async () => {
		const stats = { active: 0, maxActive: 0 };
		registerProviders(
			Array.from({ length: 20 }, (_, index) =>
				createProvider(`provider-${index}`, async () => {
					stats.active += 1;
					stats.maxActive = Math.max(stats.maxActive, stats.active);
					await new Promise((resolve) => {
						setTimeout(resolve, 5);
					});
					stats.active -= 1;

					return [];
				}),
			),
		);

		await subtitleProviderService.search({ mediaFileId, languages: ["pl"] });

		expect(stats.maxActive).toBe(serverConfig.plugins.subtitles.providerConcurrency);
	});

	test("a provider that is switched off is not searched", async () => {
		registerProviders([
			createProvider("on", async () => [{ id: "candidate-1", language: "pl", label: "Example Movie", format: "vtt" }]),
			createProvider("off", async () => [{ id: "candidate-2", language: "pl", label: "Example Movie", format: "vtt" }]),
		]);
		await subtitleProviderService.setEnabled("off", false);

		const results = await subtitleProviderService.search({ mediaFileId, languages: ["pl"] });

		expect(results.map((result) => result.providerId)).toEqual(["on"]);
	});
});

describe("subtitle provider downloads", () => {
	const subtitleDownload = (text: string) => ({
		id: "candidate-1",
		language: "pl",
		label: "Polish",
		format: ".VTT",
		content: new TextEncoder().encode(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${text}\n`),
	});

	test("stores a validated download under the core subtitle directory and serves its content", async () => {
		registerProviders([
			createProvider(
				"provider-1",
				async () => [{ id: "candidate-1", language: "pl", format: "vtt" }],
				async () => subtitleDownload("Hello"),
			),
		]);

		const subtitleId = await subtitleProviderService.download("provider-1", { mediaFileId, subtitleId: "candidate-1" });

		const [row] = await db.client().select().from(schema.subtitles).where(eq(schema.subtitles.id, subtitleId));
		expect(row).toMatchObject({ mediaFileId, language: "pl", label: "Polish", format: "vtt", type: "external" });
		if (!row?.filePath) throw new Error("Downloaded subtitle was not stored with a file");

		generatedPaths.push(row.filePath);
		expect(row.filePath).toStartWith(`${serverConfig.paths.subtitles}/`);

		const content = await subtitleProviderService.getContent(subtitleId);
		if (!content) throw new Error("Downloaded subtitle content was not found");

		expect(content.contentType).toBe("text/vtt");
		expect(await content.file.text()).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n");
	});

	test("a second download in the same language replaces the earlier file and keeps one row", async () => {
		let version = 0;
		registerProviders([
			createProvider(
				"provider-1",
				async () => [],
				() => {
					version += 1;

					return Promise.resolve(subtitleDownload(`version ${version}`));
				},
			),
		]);
		const firstId = await subtitleProviderService.download("provider-1", { mediaFileId, subtitleId: "candidate-1" });
		const [first] = await storedSubtitles();

		const secondId = await subtitleProviderService.download("provider-1", { mediaFileId, subtitleId: "candidate-1" });

		const stored = await storedSubtitles();
		expect(secondId).toBe(firstId);
		expect(stored).toHaveLength(1);
		if (!(first?.filePath && stored[0]?.filePath)) throw new Error("Expected both downloads to store a file");
		generatedPaths.push(first.filePath, stored[0].filePath);
		expect(stored[0].filePath).not.toBe(first.filePath);
		expect(await Bun.file(first.filePath).exists()).toBe(false);
		expect(await (await subtitleProviderService.getContent(firstId))?.file.text()).toContain("version 2");
	});

	test("refuses a download larger than the size limit and stores nothing", async () => {
		registerProviders([
			createProvider(
				"provider-1",
				async () => [],
				async () => ({
					id: "candidate-1",
					language: "pl",
					format: "vtt",
					content: new Uint8Array(serverConfig.plugins.subtitles.maxSizeBytes + 1),
				}),
			),
		]);

		await expect(subtitleProviderService.download("provider-1", { mediaFileId, subtitleId: "candidate-1" })).rejects.toMatchObject({
			code: "plugin.subtitle.too_large",
		});
		expect(await storedSubtitles()).toEqual([]);
	});

	test("does not serve a stored file outside the core subtitle directory", async () => {
		// The file exists, so only the directory check can refuse it.
		const outsidePath = join(tmpdir(), `untrusted-${crypto.randomUUID()}.vtt`);
		await Bun.write(outsidePath, "WEBVTT\n");
		generatedPaths.push(outsidePath);
		await db.client().insert(schema.subtitles).values({
			id: "subtitle-1",
			mediaFileId,
			language: "pl",
			format: "vtt",
			type: "external",
			filePath: outsidePath,
			streamIndex: null,
		});

		await expect(subtitleProviderService.getContent("subtitle-1")).resolves.toBeNull();
	});

	test("a download from a provider that is switched off is refused", async () => {
		registerProviders([createProvider("off", async () => [])]);
		await subtitleProviderService.setEnabled("off", false);

		await expect(subtitleProviderService.download("off", { mediaFileId, subtitleId: "candidate-1" })).rejects.toMatchObject({
			code: "plugin.subtitle.provider_disabled",
		});
		expect(await storedSubtitles()).toEqual([]);
	});
});

describe("subtitle provider switches", () => {
	test("switching an unknown subtitle provider is refused and stores no switch", async () => {
		await expect(subtitleProviderService.setEnabled("missing", false)).rejects.toMatchObject({
			code: "plugin.subtitle.provider_not_found",
		});
		expect(await subtitleProviderSettingsRepository.listDisabledIds()).toEqual([]);
	});
});
