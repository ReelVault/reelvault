import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginEventInput } from "@reelvault/sdk/plugin";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { mediaArtifactsService } from "@/services/artifacts/media-artifacts.service";
import { removeTree } from "@/utils/directory.utils";
import { deleteFile, writeFile } from "@/utils/file.utils";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { StaleArtifactCleaner } from "./stale-artifact.cleaner";

const db = useTestDatabase();
const DEFAULT_IO_CONCURRENCY = 4;

type TestClient = ReturnType<typeof db.client>;

let workDir = "";
let subtitlesRoot = "";
let outsideDir = "";

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "reelvault-cleaner-"));
	subtitlesRoot = join(workDir, "subtitles");
	outsideDir = join(workDir, "elsewhere");
	await mkdir(subtitlesRoot);
	await mkdir(outsideDir);
});

afterEach(async () => {
	await removeTree(workDir);
});

/**
 * The real cleaner over the real database and filesystem. The test supplies only
 * the plugin event sink (an external boundary), the subtitles root (a config
 * path) and the I/O budget (host-dependent).
 */
function createCleaner(
	emitMediaUnavailable: (input: PluginEventInput<"media.file.unavailable">) => Promise<void>,
	ioConcurrency = DEFAULT_IO_CONCURRENCY,
): StaleArtifactCleaner {
	return new StaleArtifactCleaner({
		deleteByLibraryAndPaths: (libraryId, paths) => mediaRepository.deleteByLibraryAndPathsAndGetCleanup(libraryId, paths),
		removeArtifactStorageFiles: (keys) => mediaArtifactsService.removeStorageFiles(keys),
		invalidateArtifactByteTotals: () => mediaArtifactsService.invalidateByteTotals(),
		deleteFile: (path) => deleteFile(path),
		getIoConcurrency: () => ioConcurrency,
		subtitlesPath: () => subtitlesRoot,
		clearLibraryStatsCache: () => librariesRepository.clearStatsCache(),
		emitMediaUnavailable,
	});
}

async function libraryIdOf(client: TestClient, mediaFileId: string): Promise<string> {
	const [row] = await client
		.select({ libraryId: schema.mediaFiles.libraryId })
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, mediaFileId));
	if (!row) throw new Error(`Media file ${mediaFileId} was not inserted`);

	return row.libraryId;
}

async function remainingMediaIds(client: TestClient, libraryId: string): Promise<string[]> {
	const rows = await client.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(eq(schema.mediaFiles.libraryId, libraryId));

	return rows.map((row) => row.id).toSorted();
}

describe("StaleArtifactCleaner subtitle files", () => {
	test("deletes the subtitle files of removed media that sit under the subtitles root", async () => {
		const client = db.client();
		const keptId = await insertMovieMediaFile(client, "/media/kept.mkv", "movie-kept");
		const removedId = await insertMovieMediaFile(client, "/media/gone.mkv", "movie-gone");
		const libraryId = await libraryIdOf(client, removedId);
		const externalFile = join(subtitlesRoot, "external.vtt");
		const embeddedFile = join(subtitlesRoot, "sub-embedded.vtt");
		await writeFile(externalFile, "WEBVTT\n");
		await writeFile(embeddedFile, "WEBVTT\n");
		await client.insert(schema.subtitles).values([
			{ id: "sub-external", mediaFileId: removedId, language: "en", format: "vtt", type: "external", filePath: externalFile },
			// An extracted embedded track has no source path; its cached file is named after its id.
			{ id: "sub-embedded", mediaFileId: removedId, language: "fr", format: "vtt", type: "embedded", streamIndex: 2 },
		]);

		await createCleaner(() => Promise.resolve()).cleanup(libraryId, ["/media/gone.mkv"]);

		expect(await remainingMediaIds(client, libraryId)).toEqual([keptId]);
		expect(await Bun.file(externalFile).exists()).toBeFalse();
		expect(await Bun.file(embeddedFile).exists()).toBeFalse();
	});

	test("never deletes subtitle files stored outside the subtitles root", async () => {
		const client = db.client();
		const removedId = await insertMovieMediaFile(client, "/media/gone.mkv", "movie-gone");
		const libraryId = await libraryIdOf(client, removedId);
		const outsideFile = join(outsideDir, "outside.vtt");
		await writeFile(outsideFile, "WEBVTT\n");
		await client
			.insert(schema.subtitles)
			.values({ mediaFileId: removedId, language: "en", format: "vtt", type: "external", filePath: outsideFile });

		await createCleaner(() => Promise.resolve()).cleanup(libraryId, ["/media/gone.mkv"]);

		expect(await Bun.file(outsideFile).exists()).toBeTrue();
	});
});

describe("StaleArtifactCleaner unavailable events", () => {
	test("emits media.file.unavailable for every removed media file and no others", async () => {
		const client = db.client();
		const firstId = await insertMovieMediaFile(client, "/media/gone.mkv", "movie-gone");
		const secondId = await insertMovieMediaFile(client, "/media/gone-too.mkv", "movie-gone-too");
		await insertMovieMediaFile(client, "/media/kept.mkv", "movie-kept");
		const libraryId = await libraryIdOf(client, firstId);
		const emitted: Array<{ libraryId: string; mediaFileId: string }> = [];

		await createCleaner((input) => {
			emitted.push({ libraryId: input.libraryId, mediaFileId: input.mediaFileId });

			return Promise.resolve();
		}).cleanup(libraryId, ["/media/gone.mkv", "/media/gone-too.mkv"]);

		expect(emitted).toHaveLength(2);
		expect(emitted).toContainEqual({ libraryId, mediaFileId: firstId });
		expect(emitted).toContainEqual({ libraryId, mediaFileId: secondId });
	});

	test("emits unavailable events concurrently up to the I/O budget", async () => {
		const client = db.client();
		const firstId = await insertMovieMediaFile(client, "/media/gone-1.mkv", "movie-gone-1");
		const libraryId = await libraryIdOf(client, firstId);
		await insertMovieMediaFile(client, "/media/gone-2.mkv", "movie-gone-2");
		await insertMovieMediaFile(client, "/media/gone-3.mkv", "movie-gone-3");
		let inFlight = 0;
		let maxInFlight = 0;

		await createCleaner(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Bun.sleep(10);
			inFlight--;
		}, 3).cleanup(libraryId, ["/media/gone-1.mkv", "/media/gone-2.mkv", "/media/gone-3.mkv"]);

		expect(maxInFlight).toBe(3);
	});
});
