import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaArtifactsRepository } from "@/database/repositories/media-artifacts.repository";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { FileUtils } from "@/utils/file.utils";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { pluginArtifactsService } from "./plugin.artifacts";

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
	mediaArtifactsService.invalidateByteTotals();
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe("pluginArtifactsService.write — per-plugin quota", () => {
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
});

describe("pluginArtifactsService delegation", () => {
	test("lists artifacts from the shared store", async () => {
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

		expect(artifacts).toEqual([expect.objectContaining({ id: "a-1", url: "/v1/media-files/mf-1/artifacts/a-1" })]);
	});

	test("removeForPlugin drops every artifact of that plugin owner", async () => {
		const deleteCalls: Array<{ ids?: string[] }> = [];
		activeStubs.push(
			stubMethod(mediaArtifactsRepository, "findByPluginId", () =>
				Promise.resolve([
					{ id: "a-1", storageKey: "mf-1/a-1" },
					{ id: "a-2", storageKey: "mf-1/a-2" },
				]),
			),
			stubMethod(mediaArtifactsRepository, "delete", (params: { ids?: string[] }) => {
				deleteCalls.push(params);

				return Promise.resolve();
			}),
			stubMethod(FileUtils, "delete", () => Promise.resolve(true)),
		);

		expect(await pluginArtifactsService.removeForPlugin("org.reelvault.test")).toBe(2);
		expect(deleteCalls).toEqual([{ ids: ["a-1", "a-2"] }]);
	});
});
