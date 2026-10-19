import { type SQL, sql } from "drizzle-orm";
import type { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { type RelationJsonKeys, relationJsonArrayOver } from "@/integrations/drizzle-orm/utils/relation-json.utils";

export type PlaybackRelationClient = ReturnType<typeof databaseFactory.getClient>;

/** A JSON array bound as one parameter, expanded in SQL so one prepared statement serves every id list. */
export const metadataIdsJsonTable = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

export const seasonColumns = {
	id: schema.seasons.id,
	metadataId: schema.seasons.metadataId,
	seasonNumber: schema.seasons.seasonNumber,
};

export const episodeColumns = {
	id: schema.episodes.id,
	seasonId: schema.episodes.seasonId,
	episodeNumber: schema.episodes.episodeNumber,
	absoluteNumber: schema.episodes.absoluteNumber,
	title: schema.episodes.title,
	episodeType: schema.episodes.episodeType,
};

export type SeasonRow = Pick<typeof schema.seasons.$inferSelect, "id" | "metadataId" | "seasonNumber">;
export type EpisodeRow = Pick<
	typeof schema.episodes.$inferSelect,
	"id" | "seasonId" | "episodeNumber" | "absoluteNumber" | "title" | "episodeType"
>;

export const seasonKeys = Object.keys(seasonColumns);
export const episodeKeys = Object.keys(episodeColumns);
/** These projections carry no timestamp or boolean columns, so JSON needs no revival. */
export const noRevive: RelationJsonKeys = { booleanKeys: [], dateKeys: [] };

/**
 * Seasons and episodes as two `json_group_array` columns over one metadata scope,
 * so a caller can carry them in the statement it already runs (`= ?` for a single
 * id, `IN (json_each(?))` for a list).
 */
export function seasonsAndEpisodesJson(metadataScope: SQL, regularOnly: boolean): { seasons: SQL<string>; episodes: SQL<string> } {
	const regularFilter = regularOnly ? sql` AND ${schema.episodes.episodeType} = 'regular'` : sql``;

	return {
		seasons: relationJsonArrayOver(seasonColumns, sql`${schema.seasons} WHERE ${schema.seasons.metadataId} ${metadataScope}`),
		episodes: relationJsonArrayOver(
			episodeColumns,
			sql`${schema.episodes} JOIN ${schema.seasons} ON ${schema.seasons.id} = ${schema.episodes.seasonId} WHERE ${schema.seasons.metadataId} ${metadataScope}${regularFilter}`,
		),
	};
}
