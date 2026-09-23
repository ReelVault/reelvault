import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { metadataSidecarsService } from "./metadata-sidecars.service";
import type { SidecarSnapshotDocument } from "./sidecar.types";

const snapshot: SidecarSnapshotDocument = {
	reelvaultSchemaVersion: 1,
	title: "Arrival",
	identifiers: {},
	providerIds: {},
	genres: [],
	keywords: [],
	productionCompanies: [],
	cast: [],
	crew: [],
	ratings: [],
};

describe("metadataSidecarsService", () => {
	test("findIgnoredAssets reports unsupported artwork under a library root", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-service-assets-"));
		await mkdir(join(root, "nested"), { recursive: true });
		await Promise.all([
			write(join(root, "banner.jpg"), ""),
			write(join(root, "poster.jpg"), ""),
			write(join(root, "nested", "clearlogo.png"), ""),
		]);

		try {
			expect(await metadataSidecarsService.findIgnoredAssets(root)).toEqual([
				{ path: join(root, "banner.jpg"), fileName: "banner.jpg", reason: "unsupported-artwork-type" },
				{ path: join(root, "nested", "clearlogo.png"), fileName: "clearlogo.png", reason: "unsupported-artwork-type" },
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("readDocument parses a jellyfin sidecar and rejects unknown documents", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-service-read-"));
		const documentPath = join(directory, "movie.nfo");
		await write(documentPath, "<movie><title>Arrival</title><tmdbid>329865</tmdbid></movie>");
		const unknownPath = join(directory, "movie.txt");
		await write(unknownPath, "<movie><title>Arrival</title></movie>");

		try {
			expect(await metadataSidecarsService.readDocument(documentPath)).toMatchObject({ mediaKind: "movie", title: "Arrival" });
			expect(await metadataSidecarsService.readDocument(unknownPath)).toBeNull();
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("createSidecarWriter writes reelvault documents through the shared registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-service-writer-"));
		try {
			const writer = metadataSidecarsService.createSidecarWriter({
				metadata: async () => snapshot,
				season: async () => snapshot,
				episode: async () => snapshot,
			});

			const result = await writer.saveMovie({ metadataId: "metadata-1", movieDirectory: directory });

			expect(result.writtenFiles).toEqual([join(directory, "movie.reelvault.nfo")]);
			expect(await readdir(directory)).toEqual(["movie.reelvault.nfo"]);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	test("createSidecarWriter writes kodi-flavored documents through the shared registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-service-writer-"));
		try {
			const writer = metadataSidecarsService.createSidecarWriter({
				metadata: async () => snapshot,
				season: async () => snapshot,
				episode: async () => snapshot,
			});

			const result = await writer.saveMovie({ metadataId: "metadata-1", movieDirectory: directory, flavor: "kodi" });

			expect(result.writtenFiles).toEqual([join(directory, "movie.nfo")]);
			expect(await readdir(directory)).toEqual(["movie.nfo"]);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
