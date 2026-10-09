import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { subtitlesRepository } from "@/database/repositories/subtitles.repository";

const client = databaseFactory.getClient();

interface SubtitleRow {
	id: string;
	mediaFileId: string;
	language: string;
	label: string | null;
	format: string;
}

// Created in this order, so the default createdAt ordering is the id order.
const FIXTURES: SubtitleRow[] = [
	{ id: "s1", mediaFileId: "movie-alpha", language: "en", label: "English", format: "srt" },
	{ id: "s2", mediaFileId: "movie-beta", language: "de", label: "Deutsch", format: "srt" },
	{ id: "s3", mediaFileId: "movie-alpha", language: "pl", label: null, format: "vtt" },
];

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS subtitles (
				id TEXT PRIMARY KEY NOT NULL,
				media_file_id TEXT NOT NULL,
				language TEXT NOT NULL,
				label TEXT,
				format TEXT NOT NULL,
				type TEXT NOT NULL DEFAULT 'external',
				file_path TEXT,
				stream_index INTEGER,
				is_default INTEGER NOT NULL DEFAULT 0,
				is_forced INTEGER NOT NULL DEFAULT 0,
				is_hearing_impaired INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`),
	);
});

beforeEach(async () => {
	await client.run(sql.raw("DELETE FROM subtitles"));

	for (const [index, row] of FIXTURES.entries()) {
		await client.run(sql`
			INSERT INTO subtitles (id, media_file_id, language, label, format, type, file_path, is_default, is_forced, is_hearing_impaired, created_at, updated_at)
			VALUES (${row.id}, ${row.mediaFileId}, ${row.language}, ${row.label}, ${row.format}, 'external', ${`/subs/${row.id}.${row.format}`}, 0, 0, 0, ${index}, ${index})
		`);
	}
});

const idsOf = async (q: string): Promise<string[]> => {
	const page = await subtitlesRepository.findPage({ q, page: 1, limit: 50 });

	return page.data.map((row) => row.id);
};

describe("subtitlesRepository.findPage text query", () => {
	test("matches the label case-insensitively", async () => {
		expect(await idsOf("ENGLISH")).toEqual(["s1"]);
	});

	test("matches the language and the media file id", async () => {
		expect(await idsOf("pl")).toEqual(["s3"]);
		expect(await idsOf("movie-beta")).toEqual(["s2"]);
	});

	test("treats % as literal text, so it matches nothing here", async () => {
		expect(await idsOf("%")).toEqual([]);
	});
});
