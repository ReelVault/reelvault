import { afterEach, expect, test } from "bun:test";
import { providerService } from "@/plugins/capabilities/provider.service";
import { insertSeriesEpisode } from "../../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../../tests/helpers/method-stub.helper";
import { selectEpisodes } from "../../../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../../../tests/helpers/test-database.helper";
import { metadataRefreshService } from "./metadata-refresh.runtime";

const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

test("a title refresh fetches its seasons in the library's language, so Polish episode titles stay Polish", async () => {
	const { metadataId, episodeId } = await insertSeriesEpisode(db.client(), "pl");
	stubs.push(
		stubMethod(providerService, "fetchDetailsByProvider", (_providerId: string, _type: string, externalId: string) =>
			Promise.resolve({ externalId, title: "Serial", releaseDate: "2020-01-01", seasons: [{ seasonNumber: 1, name: "Sezon 1" }] }),
		),
		stubMethod(providerService, "fetchSeasonFromLinks", (_links: unknown, seasonNumber: number, language?: string) =>
			Promise.resolve([
				{
					provider: "tmdb",
					metadata: {
						seasonNumber,
						episodes: [{ episodeNumber: 1, name: language === "pl" ? "Pilot (polski)" : "Pilot (English)" }],
					},
				},
			]),
		),
	);

	await metadataRefreshService.refresh(metadataId, {});

	expect((await selectEpisodes(db.client())).find((row) => row.id === episodeId)).toMatchObject({ title: "Pilot (polski)" });
});
