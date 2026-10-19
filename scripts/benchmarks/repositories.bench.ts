import { bench, main, suiteArgs } from "benchkit";
import { episodesRepository } from "@/app/repositories/episodes.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { moviesRepository } from "@/app/repositories/movies.repository";
import { peopleRepository } from "@/app/repositories/people.repository";
import { playbackRepository } from "@/app/repositories/playback.repository";
import { watchedHistoryRepository } from "@/app/repositories/watched-history.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { seedCatalog } from "./lib/seed.utils";

export const meta = {
	description: "Repository read paths on an isolated DB (metadata list/detail/similar, watched-history, projected lists)",
};

const PROFILE_ID = "profile-bench";
const MOVIE_ID = "meta-0000001";

const args = suiteArgs();

if (!args.help) {
	console.log(`[repositories] migrating isolated benchmark database...`);
	databaseFactory.migrate();
	console.log(`[repositories] seeding ${args.rows} catalog rows...`);
	seedCatalog(databaseFactory.sqlite, {
		rows: args.rows,
		repositoryExtras: true,
		people: 200,
		history: { profileId: PROFILE_ID, everyNth: 3, duration: 6000 },
		series: { shows: 2, seasons: 2, episodesPerSeason: 10 },
		profile: { id: PROFILE_ID },
		analyze: true,
	});

	bench("metadataRepository.findPage (full list, 24)", async () => await metadataRepository.findPage({ limit: 24 }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench(
		"metadataRepository.findPage (projected, 24)",
		async () => await metadataRepository.findPage({ limit: 24, fields: "id,title,type,releaseDate" }),
		{ warmup: 5, iterations: args.iterations },
	);
	bench("metadataRepository.findOne (movie detail)", async () => await metadataRepository.findById({ primaryId: MOVIE_ID }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench(
		"metadataRepository.getMoreLikeThis (limit 12)",
		async () => await metadataRepository.getMoreLikeThis({ metadataId: MOVIE_ID, limit: 12, offset: 0 }),
		{ warmup: 5, iterations: args.iterations },
	);
	bench("watchedHistoryRepository.findPage (limit 50)", async () => await watchedHistoryRepository.findPage(PROFILE_ID, { limit: 50 }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench("peopleRepository.findPage (projected, 24)", async () => await peopleRepository.findPage({ limit: 24, fields: "id,name" }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench("moviesRepository.findPage (projected, 24)", async () => await moviesRepository.findPage({ limit: 24, fields: "id,metadataId" }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench(
		"episodesRepository.findPage (projected, 24)",
		async () => await episodesRepository.findPage({ limit: 24, fields: "id,title,seasonId" }),
		{ warmup: 5, iterations: args.iterations },
	);
	bench("librariesRepository.findPage (projected, 24)", async () => await librariesRepository.findPage({ limit: 24, fields: "id,name" }), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench(
		"mediaRepository.findPage (projected subtitles, 24)",
		async () => await mediaRepository.findPage({ limit: 24, fields: "id,fileName,subtitles.id,subtitles.language" }),
		{ warmup: 5, iterations: args.iterations },
	);
	bench(
		"metadataRepository.findRecentlyAddedByTypes (movie+tv, 20)",
		async () => await metadataRepository.findRecentlyAddedByTypes(["movie", "tv_show"], 20),
		{ warmup: 5, iterations: args.iterations },
	);
	bench("metadataRepository.findRootsById (prepared shape)", async () => await metadataRepository.findRootsById(MOVIE_ID), {
		warmup: 5,
		iterations: args.iterations,
	});
	bench(
		"playbackRepository.findProgressUpdateData (prepared shape)",
		async () => await playbackRepository.findProgressUpdateData(`mf-${MOVIE_ID}`, PROFILE_ID),
		{ warmup: 5, iterations: args.iterations },
	);
	bench(
		"playbackRepository.findMediaFileWithMetadata (prepared shape)",
		async () => await playbackRepository.findMediaFileWithMetadata(`mf-${MOVIE_ID}`),
		{ warmup: 5, iterations: args.iterations },
	);
	bench(
		"playbackRepository.upsertProgress (prepared shape)",
		async () =>
			await playbackRepository.upsertProgress({
				profileId: PROFILE_ID,
				fileId: `mf-${MOVIE_ID}`,
				position: 1000,
				duration: 6000,
				completed: false,
			}),
		{ warmup: 5, iterations: args.iterations },
	);
}

await main(import.meta);
