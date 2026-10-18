import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTree } from "@/utils/directory.utils";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { SidecarArtworkExporter } from "./sidecar-artwork.exporter";

const db = useTestDatabase();

function firstRow<T>(rows: T[]): T {
	const row = rows[0];
	if (!row) throw new Error("Expected the insert to return a row");

	return row;
}

async function writeWebp(path: string): Promise<void> {
	await Bun.write(
		path,
		await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } })
			.webp()
			.toBuffer(),
	);
}

/** Writes a webp file, persists it as an image row, and returns the image id. */
async function createImage(path: string): Promise<string> {
	await writeWebp(path);
	const image = firstRow(
		await db
			.client()
			.insert(schema.images)
			.values({ stableKey: crypto.randomUUID(), localPath: path, contentType: "image/webp" })
			.returning({ id: schema.images.id }),
	);

	return image.id;
}

/** Persists a movie row and links the given poster and backdrop images to it. */
async function createMetadata(metadataId: string, links: { poster?: string; backdrop?: string }): Promise<void> {
	const client = db.client();
	const metadata = firstRow(
		await client
			.insert(schema.metadata)
			.values({ id: metadataId, stableKey: metadataId, title: metadataId, type: "movie", releaseDate: "2020-01-01" })
			.returning({ id: schema.metadata.id }),
	);
	if (links.poster)
		await client.insert(schema.metadataImages).values({ metadataId: metadata.id, imageId: links.poster, imageType: "poster" });
	if (links.backdrop) {
		await client.insert(schema.metadataImages).values({ metadataId: metadata.id, imageId: links.backdrop, imageType: "backdrop" });
	}
}

/** Encoder stand-in that writes a numbered marker per call, so the stored bytes show which export ran last. */
function markingExporter(): SidecarArtworkExporter {
	let encodes = 0;

	return new SidecarArtworkExporter({
		reencodeImage: () => {
			encodes++;

			return Promise.resolve(Buffer.from(`jpeg-${encodes}`));
		},
	});
}

describe("SidecarArtworkExporter exports artwork", () => {
	test("exports poster.jpg and fanart.jpg next to a title as jpeg", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "sources"));
			await mkdir(join(directory, "target"));
			await createMetadata("metadata-1", {
				poster: await createImage(join(directory, "sources", "poster.webp")),
				backdrop: await createImage(join(directory, "sources", "backdrop.webp")),
			});

			const written = await new SidecarArtworkExporter().saveTitleArtwork({
				metadataId: "metadata-1",
				directory: join(directory, "target"),
			});

			expect(written).toEqual([join(directory, "target", "poster.jpg"), join(directory, "target", "fanart.jpg")]);
			for (const file of written) {
				const metadata = await sharp(await readFile(file)).metadata();
				expect(metadata.format).toBe("jpeg");
			}
		} finally {
			await removeTree(directory);
		}
	});

	test("exports the season poster and episode thumbnail by their conventional names", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "target"));
			const imageId = await createImage(join(directory, "still.webp"));

			const exporter = new SidecarArtworkExporter();
			const season = await exporter.saveSeasonArtwork({ imageId, directory: join(directory, "target"), seasonNumber: 2 });
			const episode = await exporter.saveEpisodeArtwork({ imageId, directory: join(directory, "target"), videoBaseName: "S01E01" });

			expect(season).toEqual([join(directory, "target", "season02-poster.jpg")]);
			expect(episode).toEqual([join(directory, "target", "S01E01-thumb.jpg")]);
		} finally {
			await removeTree(directory);
		}
	});

	test("skips exports without a persisted image", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "target"));
			const exporter = new SidecarArtworkExporter();

			const title = await exporter.saveTitleArtwork({ metadataId: "metadata-404", directory: join(directory, "target") });
			const episode = await exporter.saveEpisodeArtwork({
				imageId: "image-404",
				directory: join(directory, "target"),
				videoBaseName: "S01E01",
			});
			const noImageId = await exporter.saveSeasonArtwork({ imageId: null, directory: join(directory, "target"), seasonNumber: 1 });

			expect(title).toEqual([]);
			expect(episode).toEqual([]);
			expect(noImageId).toEqual([]);
			expect(await readdir(join(directory, "target"))).toEqual([]);
		} finally {
			await removeTree(directory);
		}
	});
});

describe("SidecarArtworkExporter skips unchanged exports", () => {
	test("keeps the file when a re-encode yields the bytes already on disk", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "sources"));
			await mkdir(join(directory, "target"));
			await createMetadata("metadata-1", {
				poster: await createImage(join(directory, "sources", "poster.webp")),
				backdrop: await createImage(join(directory, "sources", "backdrop.webp")),
			});
			const target = join(directory, "target");
			const exporter = new SidecarArtworkExporter();
			await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });
			const exported = await readFile(join(target, "poster.jpg"));

			// Touching the file changes its signature, so the stamp misses; the
			// re-encode produces identical bytes and nothing is rewritten.
			const later = new Date(Date.now() + 60_000);
			await utimes(join(target, "poster.jpg"), later, later);
			const second = await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });

			expect(second).toEqual([]);
			expect(await readFile(join(target, "poster.jpg"))).toEqual(exported);
		} finally {
			await removeTree(directory);
		}
	});

	test("skips the re-encode when neither the source nor the target changed", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "sources"));
			await mkdir(join(directory, "target"));
			await createMetadata("metadata-1", {
				poster: await createImage(join(directory, "sources", "poster.webp")),
				backdrop: await createImage(join(directory, "sources", "backdrop.webp")),
			});
			const exporter = markingExporter();
			const target = join(directory, "target");

			expect(await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target })).toHaveLength(2);
			const exported = [await readFile(join(target, "poster.jpg"), "utf8"), await readFile(join(target, "fanart.jpg"), "utf8")];
			expect(exported.toSorted()).toEqual(["jpeg-1", "jpeg-2"]);

			expect(await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target })).toEqual([]);
			expect([await readFile(join(target, "poster.jpg"), "utf8"), await readFile(join(target, "fanart.jpg"), "utf8")]).toEqual(exported);
		} finally {
			await removeTree(directory);
		}
	});
});

describe("SidecarArtworkExporter re-exports changed files", () => {
	test("re-exports the poster after its source changes and leaves the backdrop alone", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "sources"));
			await mkdir(join(directory, "target"));
			const posterSource = join(directory, "sources", "poster.webp");
			await createMetadata("metadata-1", {
				poster: await createImage(posterSource),
				backdrop: await createImage(join(directory, "sources", "backdrop.webp")),
			});
			const target = join(directory, "target");
			const exporter = markingExporter();
			await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });
			const fanartBefore = await readFile(join(target, "fanart.jpg"), "utf8");

			await Bun.write(posterSource, "a different, longer source payload");
			const second = await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });

			expect(second).toEqual([join(target, "poster.jpg")]);
			expect(await readFile(join(target, "poster.jpg"), "utf8")).toBe("jpeg-3");
			expect(await readFile(join(target, "fanart.jpg"), "utf8")).toBe(fanartBefore);
		} finally {
			await removeTree(directory);
		}
	});

	test("re-exports a target replaced outside the exporter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-artwork-"));
		try {
			await mkdir(join(directory, "sources"));
			await mkdir(join(directory, "target"));
			await createMetadata("metadata-1", {
				poster: await createImage(join(directory, "sources", "poster.webp")),
				backdrop: await createImage(join(directory, "sources", "backdrop.webp")),
			});
			const target = join(directory, "target");
			const exporter = markingExporter();
			await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });

			await Bun.write(join(target, "poster.jpg"), "externally edited poster");
			const second = await exporter.saveTitleArtwork({ metadataId: "metadata-1", directory: target });

			expect(second).toEqual([join(target, "poster.jpg")]);
			expect(await readFile(join(target, "poster.jpg"), "utf8")).toBe("jpeg-3");
		} finally {
			await removeTree(directory);
		}
	});
});
