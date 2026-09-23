import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { SubtitleProvider } from "@reelvault/sdk/plugin";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { pluginMetadataService } from "@/plugins/capabilities/plugin.metadata";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { serverConfig } from "@/server.config";
import { subtitleProviderService } from "./subtitle-provider.service";

function stubMethod(target: object, method: string, impl: (...args: never[]) => unknown): { restore(): void } {
	const original = Reflect.get(target, method);
	Reflect.set(target, method, (...args: never[]) => impl(...args));

	return {
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

interface StoredSubtitle {
	id: string;
	mediaFileId: string;
	language: string;
	label?: string | undefined;
	format: string;
	type: "external";
	filePath: string;
	isDefault: boolean;
	isForced: boolean;
	streamIndex: null;
}

let storedSubtitle: StoredSubtitle | undefined;
const providers: SubtitleProvider[] = [];
const generatedPaths: string[] = [];
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	storedSubtitle = undefined;
	providers.splice(0);
	generatedPaths.splice(0);
	activeStubs.push(
		stubMethod(subtitlesRepository, "findExternalByMediaFileAndLanguage", () => Promise.resolve(storedSubtitle)),
		stubMethod(subtitlesRepository, "findByPrimaryId", ({ primaryId }: { primaryId: string }) =>
			Promise.resolve(storedSubtitle?.id === primaryId ? storedSubtitle : undefined),
		),
		stubMethod(subtitlesRepository, "insert", ({ values }: { values: StoredSubtitle }) => {
			storedSubtitle = values;

			return Promise.resolve();
		}),
		stubMethod(subtitlesRepository, "update", ({ primaryId, values }: { primaryId: string; values: Partial<StoredSubtitle> }) => {
			if (storedSubtitle?.id === primaryId) storedSubtitle = { ...storedSubtitle, ...values };

			return Promise.resolve();
		}),
		stubMethod(pluginMediaService, "get", async (mediaFileId: string) =>
			mediaFileId === "media-1" ? { id: "media-1", metadataId: "metadata-1", fileName: "example.mkv", available: true } : null,
		),
		stubMethod(pluginMetadataService, "get", async (metadataId: string) =>
			metadataId === "metadata-1"
				? {
						id: "metadata-1",
						type: "movie" as const,
						title: "Example Movie",
						releaseDate: "2024-01-01",
						externalIds: [{ providerId: "example", entityType: "movie" as const, externalId: "example-1" }],
					}
				: null,
		),
		stubMethod(pluginManager, "getSubtitleProviders", () => providers),
		stubMethod(pluginManager, "getSubtitleProvider", (providerId: string) => providers.find((provider) => provider.id === providerId)),
	);
});

afterEach(async () => {
	for (const stub of activeStubs.toReversed()) stub.restore();

	activeStubs.length = 0;
	await Promise.all(generatedPaths.map(async (path) => await rm(path, { force: true })));
});

describe("subtitle provider service", () => {
	test("passes public metadata to healthy providers and isolates provider failures", async () => {
		providers.push(
			createProvider("healthy", async ({ media, languages }) => [
				{ id: "candidate-1", language: languages?.[0] ?? "en", label: media.title, format: "vtt" },
			]),
		);
		providers.push(
			createProvider(
				"broken",
				() =>
					new Promise(() => {
						throw new Error("Provider unavailable");
					}),
			),
		);

		await expect(subtitleProviderService.search({ mediaFileId: "media-1", languages: ["pl"] })).resolves.toEqual([
			{ providerId: "healthy", results: [{ id: "candidate-1", language: "pl", label: "Example Movie", format: "vtt" }] },
		]);
	});

	test("limits concurrent subtitle provider searches", async () => {
		const stats = { active: 0, maxActive: 0 };
		const makeProvider = (index: number) =>
			createProvider(`provider-${index}`, async () => {
				stats.active += 1;
				stats.maxActive = Math.max(stats.maxActive, stats.active);
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				stats.active -= 1;

				return [];
			});
		for (let index = 0; index < 20; index += 1) providers.push(makeProvider(index));

		await subtitleProviderService.search({ mediaFileId: "media-1", languages: ["pl"] });
		expect(stats.maxActive).toBeLessThanOrEqual(8);
	});

	test("stores a validated download below the core subtitle directory and serves it without exposing its path", async () => {
		providers.push(
			createProvider(
				"provider-1",
				async () => [{ id: "candidate-1", language: "pl", format: "vtt" }],
				async () => ({
					id: "candidate-1",
					language: "pl",
					label: "Polish",
					format: ".VTT",
					content: new TextEncoder().encode("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"),
				}),
			),
		);

		const subtitleId = await subtitleProviderService.download("provider-1", { mediaFileId: "media-1", subtitleId: "candidate-1" });
		expect(storedSubtitle).toMatchObject({ id: subtitleId, mediaFileId: "media-1", language: "pl", format: "vtt", type: "external" });
		if (!storedSubtitle) throw new Error("Downloaded subtitle was not persisted");

		generatedPaths.push(storedSubtitle.filePath);
		expect(storedSubtitle.filePath).toStartWith(`${serverConfig.paths.subtitles}/`);

		const content = await subtitleProviderService.getContent(subtitleId);
		if (!content) throw new Error("Downloaded subtitle content was not found");

		expect(content.contentType).toBe("text/vtt");
		expect(await content.file.text()).toContain("Hello");
	});

	test("does not serve a database path outside the core subtitle directory", async () => {
		storedSubtitle = {
			id: "subtitle-1",
			mediaFileId: "media-1",
			language: "pl",
			format: "vtt",
			type: "external",
			filePath: "/tmp/untrusted-subtitle.vtt",
			isDefault: false,
			isForced: false,
			streamIndex: null,
		};

		await expect(subtitleProviderService.getContent("subtitle-1")).resolves.toBeNull();
	});
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
