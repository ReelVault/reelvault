import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { mediaArtifactsRepository } from "@/database/repositories/media-artifacts.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginHookBus } from "@/plugins/runtime/plugin.hooks";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { pluginArtifactsService } from "./plugin.artifacts";

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/** Negative-path payloads are intentionally malformed; JSON.parse hands them to
 * write() without fighting the PlaybackArtifactWrite type (or banned casts). */
function malformed(json: string): Parameters<typeof pluginArtifactsService.write>[1] {
	return JSON.parse(json);
}

describe("pluginArtifactsService.write — validation order", () => {
	test("rejects a non-object artifact payload", async () => {
		await expect(pluginArtifactsService.write("org.reelvault.test", malformed('"nope"'))).rejects.toMatchObject({
			code: "plugin.artifact.invalid_request",
		});
	});

	test("rejects a missing mediaFileId", async () => {
		await expect(
			pluginArtifactsService.write("org.reelvault.test", {
				mediaFileId: "",
				kind: "chapters",
				contentType: "text/vtt",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "plugin.artifact.invalid_request" });
	});

	test("rejects an unsupported kind", async () => {
		await expect(
			pluginArtifactsService.write(
				"org.reelvault.test",
				malformed('{"mediaFileId":"mf-1","kind":"evil","contentType":"text/vtt","content":"V0VCVlRU"}'),
			),
		).rejects.toMatchObject({ code: "plugin.artifact.invalid_request" });
	});

	test("rejects a disallowed content type", async () => {
		await expect(
			pluginArtifactsService.write("org.reelvault.test", {
				mediaFileId: "mf-1",
				kind: "chapters",
				contentType: "text/html",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "plugin.artifact.invalid_content_type" });
	});

	test("rejects content above the per-artifact size limit", async () => {
		const oversized = new Uint8Array(100 * 1024 * 1024 + 1);

		await expect(
			pluginArtifactsService.write("org.reelvault.test", {
				mediaFileId: "mf-1",
				kind: "chapters",
				contentType: "text/vtt",
				content: oversized,
			}),
		).rejects.toMatchObject({ code: "plugin.artifact.too_large" });
	});

	test("rejects writes above the per-plugin storage quota", async () => {
		activeStubs.push(
			stubMethod(mediaArtifactsRepository, "findByPluginId", () =>
				Promise.resolve([{ storageKey: "mf-1/existing" }, { storageKey: "mf-1/older" }]),
			),
			stubMethod(FileUtils, "getStats", () => Promise.resolve({ size: 300 * 1024 * 1024, mtimeMs: 0 })),
		);

		await expect(
			pluginArtifactsService.write("org.reelvault.test", {
				mediaFileId: "mf-1",
				kind: "chapters",
				contentType: "text/vtt",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "plugin.artifact.quota_exceeded" });
	});

	test("rejects writes for a missing media file", async () => {
		activeStubs.push(
			stubMethod(mediaArtifactsRepository, "findByPluginId", () => Promise.resolve([])),
			stubMethod(pluginHookBus, "runBeforeArtifactCreate", (candidate: unknown) => Promise.resolve(candidate)),
			stubMethod(mediaRepository, "isExists", () => Promise.resolve(false)),
		);

		await expect(
			pluginArtifactsService.write("org.reelvault.test", {
				mediaFileId: "mf-missing",
				kind: "chapters",
				contentType: "text/vtt",
				content: bytes("WEBVTT"),
			}),
		).rejects.toMatchObject({ code: "plugin.artifact.not_found" });
	});
});

describe("pluginArtifactsService.write — happy path", () => {
	test("persists the file, returns the public artifact and publishes the event", async () => {
		activeStubs.push(
			stubMethod(mediaArtifactsRepository, "findByPluginId", () => Promise.resolve([])),
			stubMethod(pluginHookBus, "runBeforeArtifactCreate", (candidate: unknown) => Promise.resolve(candidate)),
			stubMethod(mediaRepository, "isExists", () => Promise.resolve(true)),
			stubMethod(databaseFactory, "getClient", () => ({
				insert: () => ({
					values: () => ({
						returning: () =>
							Promise.resolve([
								{
									id: "art-1",
									mediaFileId: "mf-1",
									pluginId: "org.reelvault.test",
									stableKey: "sk-1",
									kind: "trickplay",
									contentType: "text/vtt",
									storageKey: "mf-1/art-1",
									createdAt: new Date("2020-01-01T00:00:00Z"),
								},
							]),
					}),
				}),
			})),
		);
		const published: Array<{ event: string; payload: unknown }> = [];
		activeStubs.push(
			stubMethod(pluginEventBus, "publish", (event: string, payload: unknown) => {
				published.push({ event, payload });
			}),
		);

		const result = await pluginArtifactsService.write("org.reelvault.test", {
			mediaFileId: "mf-1",
			kind: "trickplay",
			contentType: "text/vtt",
			content: bytes("WEBVTT\n"),
		});

		expect(result).toMatchObject({
			id: "art-1",
			mediaFileId: "mf-1",
			pluginId: "org.reelvault.test",
			kind: "trickplay",
			contentType: "text/vtt",
			url: "/v1/media-files/mf-1/artifacts/art-1",
			createdAt: "2020-01-01T00:00:00.000Z",
		});
		expect(published).toEqual([
			{ event: "artifact.created", payload: { mediaFileId: "mf-1", artifactId: "art-1", artifactType: "trickplay" } },
		]);
	});
});

describe("pluginArtifactsService.list", () => {
	test("maps stored rows to public artifact urls", async () => {
		activeStubs.push(
			stubMethod(mediaArtifactsRepository, "findByMediaFileId", () =>
				Promise.resolve([
					{
						id: "a-1",
						mediaFileId: "mf-1",
						pluginId: "org.reelvault.test",
						kind: "chapters",
						contentType: "application/json",
						storageKey: "mf-1/a-1",
						createdAt: new Date("2021-06-01T12:00:00Z"),
					},
				]),
			),
		);

		const artifacts = await pluginArtifactsService.list("mf-1");

		expect(artifacts).toEqual([
			expect.objectContaining({
				id: "a-1",
				kind: "chapters",
				contentType: "application/json",
				url: "/v1/media-files/mf-1/artifacts/a-1",
				createdAt: "2021-06-01T12:00:00.000Z",
			}),
		]);
	});
});

describe("pluginArtifactsService.removeStorageFiles", () => {
	test("deletes each storage key under the artifacts root", async () => {
		const deleted: string[] = [];
		activeStubs.push(
			stubMethod(FileUtils, "delete", (path: string) => {
				deleted.push(path);

				return Promise.resolve(true);
			}),
		);

		await pluginArtifactsService.removeStorageFiles(["mf-1/a", "mf-1/b"]);

		expect(deleted).toHaveLength(2);
		expect(deleted[0]?.endsWith(PathUtils.join("mf-1", "a"))).toBe(true);
		expect(deleted[1]?.endsWith(PathUtils.join("mf-1", "b"))).toBe(true);
	});
});
