import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { DatabaseSidecarSnapshotResolver } from "@/app/sidecars/sidecar-snapshot.resolver";
import { removeTree } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { metadataSidecarsService } from "./metadata-sidecars.service";

const db = useTestDatabase();

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
			await removeTree(root);
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
			await removeTree(directory);
		}
	});

	test("createSidecarWriter saves a movie as movie.reelvault.nfo by default", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-service-writer-"));
		try {
			await insertMovieMediaFile(db.client(), join(directory, "Movie.mkv"), "metadata-1");
			const writer = metadataSidecarsService.createSidecarWriter(new DatabaseSidecarSnapshotResolver());

			const result = await writer.saveMovie({ metadataId: "metadata-1", movieDirectory: directory });

			expect(result.writtenFiles).toEqual([join(directory, "movie.reelvault.nfo")]);
			expect(await readdir(directory)).toEqual(["movie.reelvault.nfo"]);
			expect(await metadataSidecarsService.readDocument(join(directory, "movie.reelvault.nfo"))).toMatchObject({
				mediaKind: "movie",
				title: "metadata-1",
			});
		} finally {
			await removeTree(directory);
		}
	});

	test("createSidecarWriter saves a movie as movie.nfo in the kodi flavor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-service-writer-"));
		try {
			await insertMovieMediaFile(db.client(), join(directory, "Movie.mkv"), "metadata-1");
			const writer = metadataSidecarsService.createSidecarWriter(new DatabaseSidecarSnapshotResolver());

			const result = await writer.saveMovie({ metadataId: "metadata-1", movieDirectory: directory, flavor: "kodi" });

			expect(result.writtenFiles).toEqual([join(directory, "movie.nfo")]);
			expect(await readdir(directory)).toEqual(["movie.nfo"]);
			expect(await metadataSidecarsService.readDocument(join(directory, "movie.nfo"))).toMatchObject({
				mediaKind: "movie",
				title: "metadata-1",
			});
		} finally {
			await removeTree(directory);
		}
	});
});
