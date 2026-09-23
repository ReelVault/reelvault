import { bench, main, suiteArgs } from "benchkit";
import { databaseFactory } from "@/database/database";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { seedCatalog } from "./lib/seed";

export const meta = { description: "Repository read paths on an isolated DB (metadata list/detail/similar, watched-history)" };

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
}

await main(import.meta);
