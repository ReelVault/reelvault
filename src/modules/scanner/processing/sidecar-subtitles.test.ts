import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub";
import { findSidecarSubtitles, importSidecarSubtitles, parseSidecarSubtitleName } from "./sidecar-subtitles";

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
		await rm(dir, { recursive: true, force: true });
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

describe("importSidecarSubtitles (batch probe + bulk insert)", () => {
	let dir: string;
	const stubs: MethodStub[] = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "rv-sidecar-import-"));
		await writeFile(join(dir, "Movie.mkv"), "x");
		await writeFile(join(dir, "Movie.en.ass"), "x");
		await writeFile(join(dir, "Movie.en.sdh.srt"), "x");
		await writeFile(join(dir, "Movie.pl.forced.srt"), "x");
	});

	afterEach(() => {
		for (const stub of stubs) stub.restore();

		stubs.length = 0;
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("probes once and bulk-inserts deduplicated missing languages", async () => {
		const probe = stubMethod(subtitlesRepository, "findExternalLanguagesByMediaFile", () => Promise.resolve(new Set<string>()));
		const insert = stubMethod(subtitlesRepository, "insertReturning", ({ values }: { values: unknown }) =>
			Promise.resolve(Array.isArray(values) ? values : [values]),
		);
		stubs.push(probe, insert);

		const imported = await importSidecarSubtitles("media-1", join(dir, "Movie.mkv"));

		expect(imported).toBe(2);
		expect(probe.calls).toHaveLength(1);
		expect(insert.calls).toEqual([
			[
				expect.objectContaining({
					onConflict: "doNothing",
					values: [expect.objectContaining({ language: "en", format: "ass" }), expect.objectContaining({ language: "pl", format: "srt" })],
				}),
			],
		]);
	});

	test("skips languages that already have an external row", async () => {
		const probe = stubMethod(subtitlesRepository, "findExternalLanguagesByMediaFile", () => Promise.resolve(new Set(["pl"])));
		const insert = stubMethod(subtitlesRepository, "insertReturning", ({ values }: { values: unknown }) =>
			Promise.resolve(Array.isArray(values) ? values : [values]),
		);
		stubs.push(probe, insert);

		const imported = await importSidecarSubtitles("media-1", join(dir, "Movie.mkv"));

		expect(imported).toBe(1);
		expect(insert.calls).toEqual([[expect.objectContaining({ values: [expect.objectContaining({ language: "en" })] })]]);
	});

	test("does not insert when every language is already imported", async () => {
		const probe = stubMethod(subtitlesRepository, "findExternalLanguagesByMediaFile", () => Promise.resolve(new Set(["en", "pl"])));
		const insert = stubMethod(subtitlesRepository, "insertReturning", () => Promise.resolve([]));
		stubs.push(probe, insert);

		expect(await importSidecarSubtitles("media-1", join(dir, "Movie.mkv"))).toBe(0);
		expect(insert.calls).toHaveLength(0);
	});
});
