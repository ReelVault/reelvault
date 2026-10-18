import { beforeEach, describe, expect, test } from "bun:test";
import { subtitlesRepository } from "@/app/repositories/subtitles.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../helpers/media.fixture";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();

type FileKey = "alpha" | "beta";

interface SubtitleFixture {
	id: string;
	file: FileKey;
	language: string;
	label: string | null;
	format: "srt" | "vtt";
}

// Created in this order, so the default createdAt ordering is the id order.
const FIXTURES: SubtitleFixture[] = [
	{ id: "s1", file: "alpha", language: "en", label: "English", format: "srt" },
	{ id: "s2", file: "beta", language: "de", label: "Deutsch", format: "srt" },
	{ id: "s3", file: "alpha", language: "pl", label: null, format: "vtt" },
];

let fileIds: Record<FileKey, string>;

beforeEach(async () => {
	const client = db.client();
	fileIds = {
		alpha: await insertMovieMediaFile(client, "/movies/alpha.mkv", "meta-alpha"),
		beta: await insertMovieMediaFile(client, "/movies/beta.mkv", "meta-beta"),
	};
	await client.insert(schema.subtitles).values(
		FIXTURES.map((row, index) => ({
			id: row.id,
			mediaFileId: fileIds[row.file],
			language: row.language,
			label: row.label,
			format: row.format,
			filePath: `/subs/${row.id}.${row.format}`,
			createdAt: new Date(index * 1000),
			updatedAt: new Date(index * 1000),
		})),
	);
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
		expect(await idsOf(fileIds.beta)).toEqual(["s2"]);
	});

	test("treats % as literal text, so it matches nothing here", async () => {
		expect(await idsOf("%")).toEqual([]);
	});
});
