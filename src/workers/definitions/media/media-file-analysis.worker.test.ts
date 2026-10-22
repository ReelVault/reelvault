import { afterEach, describe, expect, test } from "bun:test";
import type { PluginMediaFile } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { analyzeMediaFileTask } from "./media-file-analysis.worker";

// The media row and the analysis write are real: the task reads the file through the real
// service and the test reads the stored tag back. The plugin's answer and the event bus are
// the boundaries, so the test supplies them.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

async function qualityTagOf(mediaFileId: string): Promise<string | null | undefined> {
	const [row] = await db
		.client()
		.select({ qualityTag: schema.mediaFiles.qualityTag })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, mediaFileId));

	return row?.qualityTag;
}

describe("media-file-analysis worker", () => {
	test("persists the plugin analysis on the media file, then emits media ready", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/movies/movie.mkv", "metadata-1");
		const analyzed: PluginMediaFile[] = [];
		const emitted: unknown[] = [];
		let tagAtEmit: string | null | undefined;
		stubs.push(
			stubMethod(pluginRegistry, "analyzeMedia", (media: PluginMediaFile) => {
				analyzed.push(media);

				return Promise.resolve({ qualityTag: "1080p" });
			}),
			stubMethod(pluginEventBus, "emit", async (event: string, input: unknown) => {
				tagAtEmit = await qualityTagOf(mediaFileId);
				emitted.push({ event, input });
			}),
		);

		await expect(analyzeMediaFileTask({ libraryId: "library-1", mediaFileId, metadataId: "metadata-1" })).resolves.toEqual({
			mediaFileId,
			analyzed: true,
		});

		expect(analyzed).toMatchObject([{ id: mediaFileId, metadataId: "metadata-1", fileName: "movie.mkv" }]);
		// The listeners of media.file.ready already see the analysis the task stored.
		expect(tagAtEmit).toBe("1080p");
		expect(emitted).toEqual([
			{
				event: "media.file.ready",
				input: { libraryId: "library-1", mediaFileId, metadataId: "metadata-1", correlationId: mediaFileId },
			},
		]);
	});

	test("emits media ready and leaves the row untouched when no plugin answers the analysis", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), "/movies/movie.mkv", "metadata-1");
		let emittedEvent = "";
		stubs.push(
			stubMethod(pluginRegistry, "analyzeMedia", () => Promise.resolve({})),
			stubMethod(pluginEventBus, "emit", (event: string) => {
				emittedEvent = event;

				return Promise.resolve(undefined);
			}),
		);

		await expect(analyzeMediaFileTask({ libraryId: "library-1", mediaFileId, metadataId: "metadata-1" })).resolves.toEqual({
			mediaFileId,
			analyzed: false,
		});

		expect(await qualityTagOf(mediaFileId)).toBeNull();
		expect(emittedEvent).toBe("media.file.ready");
	});
});
