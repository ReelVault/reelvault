import { and, eq, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";

export type PlaybackRelationClient = ReturnType<typeof databaseFactory.getClient>;

/** A JSON array bound as one parameter, expanded in SQL so one prepared statement serves every id list. */
export const metadataIdsJsonTable = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

const episodeColumns = {
	id: schema.episodes.id,
	seasonId: schema.episodes.seasonId,
	episodeNumber: schema.episodes.episodeNumber,
	absoluteNumber: schema.episodes.absoluteNumber,
	title: schema.episodes.title,
	episodeType: schema.episodes.episodeType,
};

function episodesOfSeasons(client: PlaybackRelationClient, regularOnly: boolean) {
	return client
		.select(episodeColumns)
		.from(schema.episodes)
		.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
		.where(
			and(inArray(schema.seasons.metadataId, metadataIdsJsonTable), regularOnly ? eq(schema.episodes.episodeType, "regular") : undefined),
		)
		.prepare();
}

const preparedSeasons = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			id: schema.seasons.id,
			metadataId: schema.seasons.metadataId,
			seasonNumber: schema.seasons.seasonNumber,
		})
		.from(schema.seasons)
		.where(inArray(schema.seasons.metadataId, metadataIdsJsonTable))
		.prepare(),
);

const preparedEpisodes = createPreparedQuery((client: PlaybackRelationClient) => episodesOfSeasons(client, false));
const preparedRegularEpisodes = createPreparedQuery((client: PlaybackRelationClient) => episodesOfSeasons(client, true));

/**
 * Seasons + episodes of the given titles. `regularOnly` drops specials,
 * which the continue-watching view does not surface.
 */
export async function findSeasonsAndEpisodes(
	metadataIds: readonly string[],
	options?: { regularOnly?: boolean; tx?: DatabaseTransaction },
) {
	const client = databaseFactory.getClient({ tx: options?.tx });
	const ids = JSON.stringify([...metadataIds]);

	const [seasons, episodes] = await Promise.all([
		preparedSeasons(client).execute({ ids }),
		(options?.regularOnly ? preparedRegularEpisodes(client) : preparedEpisodes(client)).execute({ ids }),
	]);

	return { seasons, episodes };
}
