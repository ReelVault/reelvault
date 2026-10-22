import { afterEach, expect, test } from "bun:test";
import { providerService } from "@/plugins/capabilities/provider.service";
import { insertSeriesEpisode } from "../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { selectEpisodes } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { episodesService } from "./episodes.service";

const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

test("refreshes an episode in its library's language, so a Polish title stays Polish", async () => {
	const { episodeId } = await insertSeriesEpisode(db.client(), "pl");
	stubs.push(
		stubMethod(providerService, "fetchEpisodeFromLinks", (_links: unknown, _season: number, _episode: number, language?: string) =>
			Promise.resolve([
				{ provider: "tmdb", metadata: { episodeNumber: 1, name: language === "pl" ? "Pilot (polski)" : "Pilot (English)" } },
			]),
		),
	);

	await episodesService.refresh(episodeId);

	expect((await selectEpisodes(db.client())).find((row) => row.id === episodeId)).toMatchObject({ title: "Pilot (polski)" });
});
