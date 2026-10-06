import { afterEach, describe, expect, test } from "bun:test";
import type { PluginMediaFile } from "@reelvault/sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { analyzeMediaFileTask } from "./media-file-analysis.worker";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

const publicMediaFile: PluginMediaFile = { id: "media-1", metadataId: "metadata-1", fileName: "movie.mkv", available: true };

describe("media-file-analysis worker", () => {
	test("emits media ready after applying plugin analysis", async () => {
		const calls: string[] = [];
		activeStubs.push(
			stubMethod(pluginMediaService, "get", () => Promise.resolve(publicMediaFile)),
			stubMethod(pluginRegistry, "analyzeMedia", (media: PluginMediaFile) => {
				expect(media).toBe(publicMediaFile);

				return Promise.resolve({ qualityTag: "1080p" });
			}),
			stubMethod(mediaRepository, "update", (input: { primaryId: string; values: unknown }) => {
				expect(input).toEqual({ primaryId: "media-1", values: { qualityTag: "1080p" } });
				calls.push("update");

				return Promise.resolve(undefined);
			}),
			stubMethod(pluginEventBus, "emit", (event: string, input: unknown) => {
				expect(event).toBe("media.file.ready");
				expect(input).toEqual({
					libraryId: "library-1",
					mediaFileId: "media-1",
					metadataId: "metadata-1",
					correlationId: "media-1",
				});
				calls.push("ready");

				return Promise.resolve(undefined);
			}),
		);

		await expect(analyzeMediaFileTask({ libraryId: "library-1", mediaFileId: "media-1", metadataId: "metadata-1" })).resolves.toEqual({
			mediaFileId: "media-1",
			analyzed: true,
		});
		expect(calls).toEqual(["update", "ready"]);
	});
});
