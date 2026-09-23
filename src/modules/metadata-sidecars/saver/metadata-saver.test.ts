import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KodiFormatAdapter } from "../formats/kodi/kodi-format.adapter";
import { ReelVaultFormatAdapter } from "../formats/reelvault/reelvault-format.adapter";
import { InMemorySidecarFormatRegistry } from "../formats/sidecar-format.registry";
import type { SidecarSnapshotDocument, SidecarSnapshotResolver } from "../sidecar.types";
import { RegistrySidecarMetadataWriter } from "./metadata-saver";

const snapshot: SidecarSnapshotDocument = {
	reelvaultSchemaVersion: 1,
	title: "Offline Movie",
	identifiers: { tmdb: "1" },
	providerIds: { tmdb: "1" },
	genres: [],
	keywords: [],
	productionCompanies: [],
	cast: [],
	crew: [],
	ratings: [],
};

function recordingResolver(): SidecarSnapshotResolver & {
	metadataCalls: () => number;
	seasonCalls: () => number;
	episodeCalls: () => number;
} {
	let metadata = 0;
	let season = 0;
	let episode = 0;

	return {
		metadata: () => {
			metadata++;

			return Promise.resolve(snapshot);
		},
		season: () => {
			season++;

			return Promise.resolve(snapshot);
		},
		episode: () => {
			episode++;

			return Promise.resolve(snapshot);
		},
		metadataCalls: () => metadata,
		seasonCalls: () => season,
		episodeCalls: () => episode,
	};
}

function createWriter(
	snapshots: SidecarSnapshotResolver,
	flavors: Array<"reelvault" | "kodi"> = ["reelvault"],
): RegistrySidecarMetadataWriter {
	const registry = new InMemorySidecarFormatRegistry();
	if (flavors.includes("reelvault")) registry.register(new ReelVaultFormatAdapter());

	if (flavors.includes("kodi")) registry.register(new KodiFormatAdapter());

	return new RegistrySidecarMetadataWriter(registry, snapshots);
}

describe("RegistrySidecarMetadataWriter", () => {
	test("saveMovie writes the reelvault movie document next to the video", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const snapshots = recordingResolver();
			const result = await createWriter(snapshots).saveMovie({ metadataId: "metadata-1", movieDirectory: directory });

			expect(result.documentPath).toBe(join(directory, "movie.reelvault.nfo"));
			expect(result.writtenFiles).toEqual([join(directory, "movie.reelvault.nfo")]);
			expect(snapshots.metadataCalls()).toBe(1);
			expect(await readFile(result.documentPath, "utf8")).toContain("Offline Movie");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("saveSeason and saveEpisode use a prebuilt snapshot without re-fetching", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const snapshots = recordingResolver();
			const writer = createWriter(snapshots);
			const seasonResult = await writer.saveSeason({ seasonId: "season-1", seasonDirectory: directory, seasonNumber: 2, snapshot });
			const episodeResult = await writer.saveEpisode({
				episodeId: "episode-1",
				episodeDirectory: directory,
				videoBaseName: "s01e01",
				snapshot,
			});

			expect(seasonResult.documentPath).toBe(join(directory, "season02-reelvault.nfo"));
			expect(episodeResult.documentPath).toBe(join(directory, "s01e01.reelvault.nfo"));
			expect(snapshots.metadataCalls()).toBe(0);
			expect(snapshots.seasonCalls()).toBe(0);
			expect(snapshots.episodeCalls()).toBe(0);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("saveEpisode falls back to the resolver when no snapshot is given", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const snapshots = recordingResolver();

			await createWriter(snapshots).saveEpisode({ episodeId: "episode-1", episodeDirectory: directory, videoBaseName: "s01e01" });

			expect(snapshots.episodeCalls()).toBe(1);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("saveMovie with the kodi flavor writes the standard movie.nfo document", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const snapshots = recordingResolver();
			const result = await createWriter(snapshots, ["kodi"]).saveMovie({
				metadataId: "metadata-1",
				movieDirectory: directory,
				flavor: "kodi",
			});

			expect(result.documentPath).toBe(join(directory, "movie.nfo"));
			const contents = await readFile(result.documentPath, "utf8");
			expect(contents).toContain("<movie>");
			expect(contents).toContain("<title>Offline Movie</title>");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("throws when no adapter is registered for the requested flavor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-saver-"));
		try {
			const registry = new InMemorySidecarFormatRegistry();

			await expect(
				new RegistrySidecarMetadataWriter(registry, recordingResolver()).saveMovie({ metadataId: "m", movieDirectory: directory }),
			).rejects.toThrow("Sidecar format adapter is not registered for writing: reelvault");
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
