import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodiFormatAdapter } from "@/modules/metadata-sidecars/formats/kodi/kodi-format.adapter";
import { ReelVaultFormatAdapter } from "@/modules/metadata-sidecars/formats/reelvault/reelvault-format.adapter";
import { InMemorySidecarFormatRegistry } from "@/modules/metadata-sidecars/formats/sidecar-format.registry";
import type { SidecarSnapshotDocument } from "@/modules/metadata-sidecars/sidecar.types";
import { removeTree } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { DatabaseSidecarSnapshotResolver } from "../sidecar-snapshot.resolver";
import { RegistrySidecarMetadataWriter } from "./metadata-saver.writer";

const db = useTestDatabase();

const prebuiltSnapshot: SidecarSnapshotDocument = {
	reelvaultSchemaVersion: 1,
	title: "Prebuilt",
	identifiers: {},
	providerIds: {},
	genres: [],
	keywords: [],
	productionCompanies: [],
	cast: [],
	crew: [],
	ratings: [],
};

function createWriter(flavors: Array<"reelvault" | "kodi"> = ["reelvault"]): RegistrySidecarMetadataWriter {
	const registry = new InMemorySidecarFormatRegistry();
	if (flavors.includes("reelvault")) registry.register(new ReelVaultFormatAdapter());

	if (flavors.includes("kodi")) registry.register(new KodiFormatAdapter());

	return new RegistrySidecarMetadataWriter(registry, new DatabaseSidecarSnapshotResolver());
}

describe("RegistrySidecarMetadataWriter", () => {
	test("saveMovie writes the reelvault movie document next to the video", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			await insertMovieMediaFile(db.client(), join(directory, "Movie.mkv"), "metadata-1");

			const result = await createWriter().saveMovie({ metadataId: "metadata-1", movieDirectory: directory });

			expect(result.documentPath).toBe(join(directory, "movie.reelvault.nfo"));
			expect(result.writtenFiles).toEqual([join(directory, "movie.reelvault.nfo")]);
			expect(await new ReelVaultFormatAdapter().read({ documentPath: result.documentPath })).toMatchObject({
				mediaKind: "movie",
				title: "metadata-1",
			});
		} finally {
			await removeTree(directory);
		}
	});

	test("saveSeason and saveEpisode write a prebuilt snapshot without looking the rows up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const writer = createWriter();

			const seasonResult = await writer.saveSeason({
				seasonId: "season-missing",
				seasonDirectory: directory,
				seasonNumber: 2,
				snapshot: prebuiltSnapshot,
			});
			const episodeResult = await writer.saveEpisode({
				episodeId: "episode-missing",
				episodeDirectory: directory,
				videoBaseName: "s01e01",
				snapshot: prebuiltSnapshot,
			});

			expect(seasonResult.documentPath).toBe(join(directory, "season02-reelvault.nfo"));
			expect(episodeResult.documentPath).toBe(join(directory, "s01e01.reelvault.nfo"));
			expect(await readFile(seasonResult.documentPath, "utf8")).toContain("Prebuilt");
			expect(await readFile(episodeResult.documentPath, "utf8")).toContain("Prebuilt");
		} finally {
			await removeTree(directory);
		}
	});

	test("saveEpisode looks the episode up when no snapshot is given", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			await expect(
				createWriter().saveEpisode({ episodeId: "episode-missing", episodeDirectory: directory, videoBaseName: "s01e01" }),
			).rejects.toMatchObject({ category: "not_found", code: "episode.not_found" });
		} finally {
			await removeTree(directory);
		}
	});

	test("saveMovie with the kodi flavor writes the standard movie.nfo document", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			await insertMovieMediaFile(db.client(), join(directory, "Movie.mkv"), "metadata-1");

			const result = await createWriter(["kodi"]).saveMovie({
				metadataId: "metadata-1",
				movieDirectory: directory,
				flavor: "kodi",
			});

			expect(result.documentPath).toBe(join(directory, "movie.nfo"));
			expect(await readFile(result.documentPath, "utf8")).toContain("<title>metadata-1</title>");
		} finally {
			await removeTree(directory);
		}
	});

	test("throws when no adapter is registered for the requested flavor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			await insertMovieMediaFile(db.client(), join(directory, "Movie.mkv"), "metadata-1");
			const writer = new RegistrySidecarMetadataWriter(new InMemorySidecarFormatRegistry(), new DatabaseSidecarSnapshotResolver());

			await expect(writer.saveMovie({ metadataId: "metadata-1", movieDirectory: directory })).rejects.toMatchObject({
				category: "internal",
				code: "sidecar.adapter_not_registered",
			});
			expect(await readdir(directory)).toEqual([]);
		} finally {
			await removeTree(directory);
		}
	});
});
