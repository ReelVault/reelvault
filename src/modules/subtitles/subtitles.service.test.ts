import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { serverConfig } from "@/config/server/server.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { clearCountCache } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { DirUtils } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { subtitleExtractorService } from "./subtitle-extractor.service";
import { subtitleInfoCache } from "./subtitle-info.cache";
import { subtitleVttPath } from "./subtitle-path.utils";
import { subtitlesService } from "./subtitles.service";

const db = useTestDatabase();
const stubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	clearCountCache();
});

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
	subtitleInfoCache.invalidate("sub-1");
});

async function seedMovie(): Promise<string> {
	return await insertMovieMediaFile(db.client(), "/media/movie.mkv", "meta-1");
}

/** ffmpeg is the process boundary: the fake names the track it was asked to extract. */
function stubExtraction(): void {
	stubs.push(
		stubMethod(
			subtitleExtractorService,
			"extractToVtt",
			(id: string, mediaFilePath: string, streamIndex: number | null | undefined, format: string | null | undefined) =>
				Promise.resolve({ contentType: "text/vtt", file: new Blob([`extracted:${id}:${mediaFilePath}:${streamIndex}:${format}`]) }),
		),
	);
}

test("getAll returns the stored subtitles as the public contract", async () => {
	const mediaFileId = await seedMovie();
	await db.client().insert(schema.subtitles).values({
		id: "sub-1",
		mediaFileId,
		language: "pl",
		label: "Polski",
		format: "vtt",
		type: "external",
		filePath: "/data/subtitles/movie.pl.vtt",
		isDefault: true,
	});

	const result = await subtitlesService.getAll();

	expect(result.total).toBe(1);
	expect(result.data).toMatchObject([
		{ id: "sub-1", mediaFileId, language: "pl", label: "Polski", format: "vtt", type: "external", streamIndex: null, isDefault: true },
	]);
});

test("getByMediaFileId returns only the subtitles of that media file", async () => {
	const client = db.client();
	const fileA = await insertMovieMediaFile(client, "/media/a.mkv", "meta-a");
	const fileB = await insertMovieMediaFile(client, "/media/b.mkv", "meta-b");
	await client.insert(schema.subtitles).values([
		{ id: "sub-1", mediaFileId: fileA, language: "eng", format: "subrip", type: "embedded", streamIndex: 2 },
		{ id: "sub-2", mediaFileId: fileB, language: "pol", format: "subrip", type: "embedded", streamIndex: 2 },
	]);

	const result = await subtitlesService.getByMediaFileId(fileB);

	expect(result).toMatchObject([{ id: "sub-2", mediaFileId: fileB }]);
});

test("getById throws not found for a missing subtitle", async () => {
	await expect(subtitlesService.getById("missing")).rejects.toMatchObject({
		category: "not_found",
		code: "entity.not_found",
		params: { entityType: "Subtitle", entityId: "missing" },
	});
});

test("create resolves an embedded subtitle type from the stream index", async () => {
	const mediaFileId = await seedMovie();

	const created = await subtitlesService.create({ mediaFileId, streamIndex: 3, language: "pl", format: "subrip" });

	expect(created).toMatchObject({ mediaFileId, type: "embedded", streamIndex: 3, format: "subrip", language: "pl" });
});

test("update drops the cached content info, so the next read sees the stored format", async () => {
	const mediaFileId = await seedMovie();
	await db
		.client()
		.insert(schema.subtitles)
		.values({ id: "sub-1", mediaFileId, language: "eng", format: "subrip", type: "embedded", streamIndex: 2 });
	expect((await subtitleInfoCache.getOrSet("sub-1")).format).toBe("subrip");
	await db.client().update(schema.subtitles).set({ format: "vtt" }).where(eq(schema.subtitles.id, "sub-1"));
	expect((await subtitleInfoCache.getOrSet("sub-1")).format).toBe("subrip");

	const updated = await subtitlesService.update("sub-1", { language: "en" });

	expect(updated).toMatchObject({ id: "sub-1", language: "en", format: "vtt" });
	expect((await subtitleInfoCache.getOrSet("sub-1")).format).toBe("vtt");
});

test("update that replaces the source deletes the previous external file", async () => {
	const mediaFileId = await seedMovie();
	await DirUtils.create(serverConfig.paths.subtitles);
	const oldPath = join(serverConfig.paths.subtitles, "replaced-old.vtt");
	await Bun.write(oldPath, "WEBVTT\n");
	await db
		.client()
		.insert(schema.subtitles)
		.values({ id: "sub-1", mediaFileId, language: "pl", format: "vtt", type: "external", filePath: oldPath });

	await subtitlesService.update("sub-1", { sourcePath: join(serverConfig.paths.subtitles, "replaced-new.vtt") });

	expect(await Bun.file(oldPath).exists()).toBeFalse();
});

test("getContent resolves an embedded track through the info cache and extraction", async () => {
	stubExtraction();
	const mediaFileId = await seedMovie();
	await db
		.client()
		.insert(schema.subtitles)
		.values({ id: "sub-1", mediaFileId, language: "eng", format: "subrip", type: "embedded", streamIndex: 2 });

	const content = await subtitlesService.getContent("sub-1");

	expect(content.contentType).toBe("text/vtt");
	expect(await content.file.text()).toBe("extracted:sub-1:/media/movie.mkv:2:subrip");
});

test("delete removes the row and its extracted VTT cache", async () => {
	const mediaFileId = await seedMovie();
	await db
		.client()
		.insert(schema.subtitles)
		.values({ id: "sub-1", mediaFileId, language: "pl", format: "vtt", type: "external", filePath: "/data/subtitles/movie.pl.vtt" });
	await DirUtils.create(serverConfig.paths.subtitles);
	const vttPath = subtitleVttPath(serverConfig.paths.subtitles, "sub-1");
	await Bun.write(vttPath, "WEBVTT\n");

	await expect(subtitlesService.delete("sub-1")).resolves.toEqual({ success: true });

	expect(await db.client().select({ id: schema.subtitles.id }).from(schema.subtitles)).toEqual([]);
	expect(await Bun.file(vttPath).exists()).toBeFalse();
});

test("delete throws not found when the row is gone", async () => {
	await expect(subtitlesService.delete("sub-1")).rejects.toMatchObject({
		category: "not_found",
		code: "entity.not_found",
		params: { entityType: "Subtitle", entityId: "sub-1" },
	});
});

test("downloadFromProvider returns the downloaded subtitle as the public contract", async () => {
	const mediaFileId = await seedMovie();
	await db
		.client()
		.insert(schema.subtitles)
		.values({ id: "sub-1", mediaFileId, language: "pl", format: "vtt", type: "external", filePath: "/data/subtitles/movie.pl.vtt" });
	stubs.push(stubMethod(subtitleProviderService, "download", () => Promise.resolve("sub-1")));

	const result = await subtitlesService.downloadFromProvider("provider-1", { mediaFileId, subtitleId: "p-sub-1" });

	expect(result).toMatchObject({ id: "sub-1", mediaFileId, type: "external", language: "pl" });
});

test("downloadFromProvider throws not found when the download has no subtitle row", async () => {
	stubs.push(stubMethod(subtitleProviderService, "download", () => Promise.resolve("gone")));

	await expect(subtitlesService.downloadFromProvider("provider-1", { mediaFileId: "file-1", subtitleId: "p-sub-1" })).rejects.toMatchObject(
		{ category: "not_found", code: "entity.not_found" },
	);
});
