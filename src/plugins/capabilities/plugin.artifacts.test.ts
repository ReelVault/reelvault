import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { deleteFile as actualDeleteFile, getFileStats as actualGetFileStats } from "@/utils/file.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { mockModule } from "../../../tests/helpers/module-mock.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { pluginArtifactsService } from "./plugin.artifacts";

let getFileStatsImpl: (path: string) => Promise<unknown> = actualGetFileStats;
mockModule("@/utils/file.utils", () => ({ deleteFile: actualDeleteFile, getFileStats: (path: string) => getFileStatsImpl(path) }));

const PLUGIN_ID = "org.reelvault.test";
const db = useTestDatabase();
const activeStubs: Array<{ restore(): void }> = [];
let mediaFileId = "";

beforeEach(async () => {
	activeStubs.length = 0;
	mediaArtifactsService.invalidateByteTotals();
	mediaFileId = await insertMovieMediaFile(db.client(), "/media/movie.mkv", "meta-1");
});

afterEach(() => {
	getFileStatsImpl = actualGetFileStats;
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function writeChapters(text: string) {
	return pluginArtifactsService.write(PLUGIN_ID, { mediaFileId, kind: "chapters", contentType: "text/vtt", content: bytes(text) });
}

describe("pluginArtifactsService.write — per-plugin quota", () => {
	test("rejects writes above the per-plugin storage quota", async () => {
		await writeChapters("WEBVTT 1");
		await writeChapters("WEBVTT 2");
		// The stored files now report 300 MB each, so the next write is over the quota.
		getFileStatsImpl = () => Promise.resolve({ size: 300 * 1024 * 1024, mtimeMs: 0 });
		mediaArtifactsService.invalidateByteTotals();

		await expect(writeChapters("WEBVTT 3")).rejects.toMatchObject({ code: "plugin.artifact.quota_exceeded" });
	});
});

describe("pluginArtifactsService delegation", () => {
	test("lists the stored artifacts with their download url", async () => {
		const written = await writeChapters("WEBVTT");

		const artifacts = await pluginArtifactsService.list(mediaFileId);

		expect(artifacts).toEqual([expect.objectContaining({ id: written.id, url: `/v1/media-files/${mediaFileId}/artifacts/${written.id}` })]);
	});

	test("removeForPlugin drops every artifact of that plugin owner", async () => {
		await writeChapters("WEBVTT 1");
		await writeChapters("WEBVTT 2");

		expect(await pluginArtifactsService.removeForPlugin(PLUGIN_ID)).toBe(2);
		expect(await pluginArtifactsService.list(mediaFileId)).toEqual([]);
	});
});
