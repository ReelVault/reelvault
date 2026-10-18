import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { removeTree } from "@/utils/directory.utils";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { findSidecarSubtitles, importSidecarSubtitles, parseSidecarSubtitleName } from "./sidecar-subtitles.utils";

describe("parseSidecarSubtitleName", () => {
	test("accepts an exact-base subtitle without language", () => {
		expect(parseSidecarSubtitleName("Movie (2010)", "Movie (2010).srt")).toEqual({
			extension: "srt",
			isDefault: false,
			isForced: false,
			isHearingImpaired: false,
		});
	});

	test("parses language and flag tokens", () => {
		expect(parseSidecarSubtitleName("Movie (2010)", "Movie (2010).pl.forced.srt")).toEqual({
			extension: "srt",
			language: "pl",
			isDefault: false,
			isForced: true,
			isHearingImpaired: false,
		});
		expect(parseSidecarSubtitleName("Movie (2010)", "Movie (2010).en.default.sdh.ass")).toEqual({
			extension: "ass",
			language: "en",
			isDefault: true,
			isForced: false,
			isHearingImpaired: true,
		});
	});

	test("rejects subtitles belonging to a different video", () => {
		expect(parseSidecarSubtitleName("Movie (2010)", "Other Show S01E01.pl.srt")).toBeNull();
		expect(parseSidecarSubtitleName("Movie (2010)", "Movie (2010).srt.bak")).toBeNull();
		expect(parseSidecarSubtitleName("Movie (2010)", "poster.jpg")).toBeNull();
	});
});

describe("findSidecarSubtitles", () => {
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "rv-sidecar-"));
	});

	afterAll(async () => {
		await removeTree(dir);
	});

	test("collects matching sidecars with languages and formats, sorted by path", async () => {
		const video = join(dir, "Show (2020).mkv");
		await writeFile(video, "x");
		await writeFile(join(dir, "Show (2020).pl.srt"), "x");
		await writeFile(join(dir, "Show (2020).en.ass"), "x");
		await writeFile(join(dir, "Show (2020).srt"), "x");
		await writeFile(join(dir, "Other (2021).pl.srt"), "x");

		const found = await findSidecarSubtitles(video);
		expect(found.map((f) => f.language)).toEqual(["en", "pl", "und"]);
		expect(found[0]?.format).toBe("ass");
		expect(found.every((f) => f.filePath.startsWith(dir))).toBe(true);
	});

	test("returns empty for a missing directory", async () => {
		expect(await findSidecarSubtitles(join(dir, "nope", "video.mkv"))).toEqual([]);
	});
});

describe("importSidecarSubtitles", () => {
	test("is resilient to a missing video directory", async () => {
		expect(await importSidecarSubtitles("media-1", join(tmpdir(), "rv-none", "video.mkv"))).toBe(0);
	});
});

describe("importSidecarSubtitles against stored subtitles", () => {
	const db = useTestDatabase();
	let dir: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "rv-sidecar-import-"));
		await writeFile(join(dir, "Movie.mkv"), "x");
		await writeFile(join(dir, "Movie.en.ass"), "x");
		await writeFile(join(dir, "Movie.en.sdh.srt"), "x");
		await writeFile(join(dir, "Movie.pl.forced.srt"), "x");
	});

	afterAll(async () => {
		await removeTree(dir);
	});

	async function storedSubtitles(mediaFileId: string) {
		return await db.client().select().from(schema.subtitles).where(eq(schema.subtitles.mediaFileId, mediaFileId));
	}

	test("stores one external row per missing language and keeps the first file for a language", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), join(dir, "Movie.mkv"));

		expect(await importSidecarSubtitles(mediaFileId, join(dir, "Movie.mkv"))).toBe(2);

		const rows = await storedSubtitles(mediaFileId);
		expect(
			rows.toSorted((a, b) => a.language.localeCompare(b.language)).map((row) => [row.language, row.format, row.type, row.isForced]),
		).toEqual([
			["en", "ass", "external", false],
			["pl", "srt", "external", true],
		]);
	});

	test("keeps an existing external row for a language and imports only the rest", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), join(dir, "Movie.mkv"));
		await db.client().insert(schema.subtitles).values({
			mediaFileId,
			language: "pl",
			format: "srt",
			type: "external",
			filePath: "/elsewhere/Movie.pl.srt",
		});

		expect(await importSidecarSubtitles(mediaFileId, join(dir, "Movie.mkv"))).toBe(1);

		const rows = await storedSubtitles(mediaFileId);
		expect(rows.find((row) => row.language === "pl")?.filePath).toBe("/elsewhere/Movie.pl.srt");
		expect(rows.map((row) => row.language).toSorted()).toEqual(["en", "pl"]);
	});

	test("imports nothing when every language already has an external row", async () => {
		const mediaFileId = await insertMovieMediaFile(db.client(), join(dir, "Movie.mkv"));
		await db
			.client()
			.insert(schema.subtitles)
			.values([
				{ mediaFileId, language: "en", format: "srt", type: "external", filePath: "/elsewhere/Movie.en.srt" },
				{ mediaFileId, language: "pl", format: "srt", type: "external", filePath: "/elsewhere/Movie.pl.srt" },
			]);

		expect(await importSidecarSubtitles(mediaFileId, join(dir, "Movie.mkv"))).toBe(0);

		const rows = await storedSubtitles(mediaFileId);
		expect(rows.toSorted((a, b) => a.language.localeCompare(b.language)).map((row) => row.filePath)).toEqual([
			"/elsewhere/Movie.en.srt",
			"/elsewhere/Movie.pl.srt",
		]);
	});
});
