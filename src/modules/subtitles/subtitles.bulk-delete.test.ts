import { expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { insertMovieMediaFile } from "../../../tests/helpers/media.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { subtitlesService } from "./subtitles.service";

const db = useTestDatabase();

test("bulk delete removes each subtitle once and reports a missing one by its code", async () => {
	const client = db.client();
	const mediaFileId = await insertMovieMediaFile(client, "/media/movie.mkv", "meta-1");
	await client.insert(schema.subtitles).values([
		{ id: "sub-1", mediaFileId, language: "eng", format: "subrip", type: "embedded", streamIndex: 2 },
		{ id: "sub-2", mediaFileId, language: "pol", format: "subrip", type: "embedded", streamIndex: 3 },
	]);

	const outcome = await subtitlesService.bulkDelete(["sub-1", "sub-missing", "sub-1", "sub-2"]);

	expect(outcome).toEqual({
		results: [
			{ id: "sub-1", ok: true },
			{ id: "sub-missing", ok: false, code: "entity.not_found" },
			{ id: "sub-2", ok: true },
		],
	});
	expect(await client.select({ id: schema.subtitles.id }).from(schema.subtitles)).toEqual([]);
});
