import { describe, expect, test } from "bun:test";
import { definePlugin, type ReelVaultPlugin } from "@sdk/plugin";
import { createPluginTestHost } from "@sdk/testing";
import { Type } from "@sinclair/typebox";

const plugin: ReelVaultPlugin = definePlugin({
	async setup(host) {
		await host.subtitles.register({
			id: "subtitle-example",
			name: "Subtitle example",
			version: "1.0.0",
			initialize: () => undefined,
			search: async () => [],
			download: async () => null,
		});
		await host.media.registerAnalyzer({
			id: "filename-tags",
			name: "Filename tags",
			version: "1.0.0",
			analyze: () => ({ qualityTag: "2160p" }),
		});
		await host.jobs.register({ name: "refresh", handler: () => ({ refreshed: true }) });
		await host.routes.register({
			method: "GET",
			path: "/status",
			response: Type.Object({ ok: Type.Boolean() }),
			handler: () => ({ body: { ok: true } }),
		});
		host.access.register({ id: "allow-streaming", beforeAccess: () => undefined });
		await host.notifications.create({ userId: "user-1", type: "library.updated", title: "Library updated" });
		await host.storage.set("example", { enabled: true });
		await host.storage.delete("unused");
		await host.storage.putBlob("cache-response", new Uint8Array([1, 2, 3]), {
			contentType: "application/octet-stream",
			expiresInMs: 60_000,
		});
		host.events.on("media.file.ready", async ({ mediaFileId, payloadVersion }) => {
			expect(payloadVersion).toBe(1);
			await host.jobs.enqueue("refresh", { mediaFileId }, { dedupeKey: mediaFileId });
		});
		host.hooks.beforeMetadataSave(({ candidate }) => ({ ...candidate, title: candidate.title.trim() }));
		host.hooks.beforeMediaRecognition(({ candidate }) => ({ ...candidate, title: candidate.title.trim() }));
		host.hooks.beforeArtifactCreate(({ candidate }) => ({ ...candidate, kind: "preview", contentType: "application/json" }));
	},
});

describe("plugin test host", () => {
	test("runs a plugin without the server and records its registrations", async () => {
		const host = createPluginTestHost({ enabled: true });
		host.setMediaFile({ id: "file-1", metadataId: "metadata-1", fileName: "movie.mkv", durationMs: 60_000, available: true });
		host.setMetadataItem({
			id: "metadata-1",
			type: "movie",
			title: "Example movie",
			releaseDate: "2024-01-01",
			externalIds: [{ providerId: "example", entityType: "movie", externalId: "movie-1" }],
		});
		await plugin.setup(host);

		expect(host.config).toEqual({ enabled: true });
		expect(host.registeredMediaAnalyzers).toHaveLength(1);
		expect(host.registeredSubtitleProviders).toHaveLength(1);
		expect(host.registeredJobs).toHaveLength(1);
		expect(host.registeredRoutes).toHaveLength(1);
		expect(host.registeredAccessPolicies).toHaveLength(1);
		expect(host.createdNotifications).toEqual([{ userId: "user-1", type: "library.updated", title: "Library updated" }]);
		await expect(
			host.checkAccess({ userId: "user-1", resource: "stream", action: "play", mediaFileId: "file-1" }),
		).resolves.toBeUndefined();
		await expect(host.storage.get("example")).resolves.toEqual({ enabled: true });
		const blob = await host.storage.getBlob("cache-response");
		expect(blob?.size).toBe(3);
		expect(await blob?.content.bytes()).toEqual(new Uint8Array([1, 2, 3]));
		await expect(host.media.get("file-1")).resolves.toMatchObject({ metadataId: "metadata-1" });
		await expect(host.metadata.get("metadata-1")).resolves.toEqual({
			id: "metadata-1",
			type: "movie",
			title: "Example movie",
			releaseDate: "2024-01-01",
			externalIds: [{ providerId: "example", entityType: "movie", externalId: "movie-1" }],
		});
		await expect(host.metadata.get("missing")).resolves.toBeNull();
		await expect(
			host.artifacts.write({
				mediaFileId: "file-1",
				kind: "chapters",
				contentType: "application/json",
				content: new Uint8Array([123, 125]),
			}),
		).resolves.toMatchObject({ mediaFileId: "file-1", kind: "preview" });
		await expect(host.artifacts.list("file-1")).resolves.toHaveLength(1);
		await expect(host.ffmpeg.extractFrame({ mediaFileId: "file-1", timeMs: 10_000 })).resolves.toMatchObject({
			contentType: "image/webp",
		});
		await expect(
			host.emit("media.file.ready", {
				libraryId: "library-1",
				mediaFileId: "file-1",
				metadataId: "metadata-1",
				correlationId: "scan-1",
			}),
		).resolves.toBeUndefined();
		expect(host.enqueuedJobs).toEqual([{ name: "refresh", data: { mediaFileId: "file-1" }, options: { dedupeKey: "file-1" } }]);
		await expect(
			host.runBeforeMetadataSave({
				type: "movie",
				identity: { providerId: "tmdb", entityType: "movie", externalId: "1" },
				title: "  Movie  ",
				artwork: [],
			}),
		).resolves.toMatchObject({ title: "Movie" });
		await expect(host.runBeforeMediaRecognition({ type: "movie", title: "  Movie  " })).resolves.toEqual({
			type: "movie",
			title: "Movie",
		});
	});
});
