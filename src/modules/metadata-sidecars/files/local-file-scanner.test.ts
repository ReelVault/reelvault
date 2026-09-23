import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { write } from "bun";
import { FilesystemLocalFileScanner } from "./local-file-scanner";

test("local file scanner maps only supported movie artwork and reports logos", async () => {
	const root = await mkdtemp(join(tmpdir(), "reelvault-sidecars-"));
	const movieDirectory = join(root, "Movie");
	await mkdir(movieDirectory);
	const videoPath = join(movieDirectory, "Movie.mkv");
	await Promise.all([
		write(videoPath, "video"),
		write(join(movieDirectory, "movie.nfo"), "<movie />"),
		write(join(movieDirectory, "FOLDER.JPG"), "poster"),
		write(join(movieDirectory, "backdrop2.jpg"), "backdrop"),
		write(join(movieDirectory, "logo.png"), "ignored"),
	]);

	try {
		const folder = await new FilesystemLocalFileScanner(root).inspectMovie(videoPath);
		expect(folder).toMatchObject({
			videoPaths: [videoPath],
			documentPath: join(movieDirectory, "movie.nfo"),
			artwork: { poster: { path: join(movieDirectory, "FOLDER.JPG") }, backdrop: { path: join(movieDirectory, "backdrop2.jpg") } },
		});
		expect(folder.ignoredAssets).toEqual([
			{ path: join(movieDirectory, "logo.png"), fileName: "logo.png", reason: "unsupported-artwork-type" },
		]);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("local file scanner rejects a path outside the library root", async () => {
	const root = await mkdtemp(join(tmpdir(), "reelvault-sidecars-"));
	try {
		await expect(new FilesystemLocalFileScanner(root).inspectMovie(join(tmpdir(), "outside.mkv"))).rejects.toThrow(
			"inside configured library root",
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
