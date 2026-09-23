import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "@/utils/file.utils";
import type { SidecarSnapshotDocument } from "../../sidecar.types";
import { readJellyfinEpisodeDocument } from "../jellyfin/jellyfin-episode-document.reader";
import { readJellyfinMovieDocument } from "../jellyfin/jellyfin-movie-document.reader";
import { KodiFormatAdapter } from "./kodi-format.adapter";

const adapter = new KodiFormatAdapter();

function snapshot(overrides: Partial<SidecarSnapshotDocument> = {}): SidecarSnapshotDocument {
	return {
		reelvaultSchemaVersion: 1,
		title: "Backrooms. Bez wyjścia <&>",
		originalTitle: "Backrooms",
		releaseDate: "2026-05-27",
		year: 2026,
		overview: "Clark natrafia na przejście do plątaniny korytarzy.",
		tagline: "Zobacz, jak daleko to zajdzie.",
		status: "Released",
		identifiers: { imdb: "tt26657236", tmdb: "1083381" },
		providerIds: {},
		genres: ["Horror", "Sci-Fi"],
		keywords: [],
		productionCompanies: ["A24"],
		cast: [{ name: "Kayla Foster", character: "Dźwiękowiec", order: 0 }],
		crew: [{ name: "Kane Parsons", job: "Director" }],
		ratings: [{ source: "tmdb", value: 7.1 }],
		...overrides,
	};
}

describe("KodiFormatAdapter", () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	});

	test("writes a standard movie.nfo that the Jellyfin reader reads back without loss", async () => {
		const directory = await tempDirectory();

		const result = await adapter.write({ documentPath: join(directory, "movie.nfo"), document: snapshot() });

		expect(result.writtenFiles).toEqual([join(directory, "movie.nfo")]);
		expect(await readdir(directory)).toEqual(["movie.nfo"]);

		const document = await readJellyfinMovieDocument({ documentPath: join(directory, "movie.nfo") });
		expect(document?.identifiers).toEqual({ imdb: "tt26657236", tmdb: "1083381" });
		expect(document?.title).toBe("Backrooms. Bez wyjścia <&>");
		expect(document?.ratings).toEqual([{ source: "tmdb", value: 7.1 }]);
		expect(document?.cast).toEqual([{ name: "Kayla Foster", character: "Dźwiękowiec", order: 0 }]);
		expect(document?.genres).toEqual(["Horror", "Sci-Fi"]);
	});

	test("round-trips episode placement numbers through <episodedetails>", async () => {
		const directory = await tempDirectory();
		const documentPath = join(directory, "Show.S01E03.nfo");

		await adapter.write({
			documentPath,
			document: snapshot({ title: "Episode Three", seasonNumber: 1, episodeNumber: 3, identifiers: {}, cast: [], crew: [], ratings: [] }),
		});

		const document = await readJellyfinEpisodeDocument({ documentPath });
		expect(document?.mediaKind).toBe("episode");
		expect(document?.title).toBe("Episode Three");
	});

	test("skips the rewrite when the existing file is byte-identical", async () => {
		const directory = await tempDirectory();
		const documentPath = join(directory, "movie.nfo");
		await adapter.write({ documentPath, document: snapshot() });
		const before = await readFile(documentPath, "utf8");

		const second = await adapter.write({ documentPath, document: snapshot() });

		expect(second.writtenFiles).toEqual([]);
		expect(await readFile(documentPath, "utf8")).toBe(before);
	});

	test("escapes XML-special characters into valid document text", async () => {
		const directory = await tempDirectory();
		const documentPath = join(directory, "movie.nfo");

		await adapter.write({ documentPath, document: snapshot() });

		const contents = await readFile(documentPath, "utf8");
		expect(contents).toContain("Backrooms. Bez wyjścia &lt;&amp;&gt;");
		expect(contents.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
	});

	async function tempDirectory(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "reelvault-kodi-writer-"));
		directories.push(directory);

		return directory;
	}
});
