import { eq, getTableColumns, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { mediaFilesJsonArray, parseEpisodeWithMediaFiles } from "@/integrations/drizzle-orm/utils/media-file-projection.builder";
import {
	aliasedColumns,
	booleanKeysOf,
	dateKeysOf,
	orderedJsonArray,
	parseJsonRelationArray,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { type LoadedMediaFileRelations, type MediaRelationClient, mediaFileRelationsJson, parseMediaFileRelations } from "./shared.utils";

const markerColumns = getTableColumns(schema.mediaMarkers);
const markerKeys = Object.keys(markerColumns);
const markerRevive = { booleanKeys: booleanKeysOf(markerColumns), dateKeys: dateKeysOf(markerColumns) };
const { selectList: markerSelectList, pairs: markerPairs } = aliasedColumns(markerColumns, "marker_");

/**
 * Playback view bootstrap: the media file, its relation graph, its markers, the
 * owning metadata root row and (for episode files) the episode with its media
 * files come back from one statement. `markers` keeps the `findByMediaFileId`
 * order (start seconds, index order for ties); the episode rides the episode
 * bundle's left-join shape, so its row and file array parse with the shared
 * reader. Without the bundle the view reads all of it in five round trips.
 */
export const preparedPlaybackContext = createPreparedQuery((client: MediaRelationClient) =>
	client
		.select({
			data: getTableColumns(schema.mediaFiles),
			root: getTableColumns(schema.metadata),
			episode: getTableColumns(schema.episodes),
			episodeMediaFiles: mediaFilesJsonArray(schema.mediaFiles.episodeId, schema.episodes.id),
			markers: orderedJsonArray(
				markerSelectList,
				markerPairs,
				sql`${schema.mediaMarkers} WHERE ${schema.mediaMarkers.mediaFileId} = ${schema.mediaFiles.id}`,
				schema.mediaMarkers.startSeconds,
			),
			...mediaFileRelationsJson,
		})
		.from(schema.mediaFiles)
		.leftJoin(schema.metadata, eq(schema.metadata.id, schema.mediaFiles.metadataId))
		.leftJoin(schema.episodes, eq(schema.episodes.id, schema.mediaFiles.episodeId))
		.where(eq(schema.mediaFiles.id, sql.placeholder("id")))
		.prepare(),
);

/** The playback view's bootstrap payload: the file, its relations, its markers, its root metadata row and its episode. */
export interface PlaybackContext {
	mediaFile: typeof schema.mediaFiles.$inferSelect & LoadedMediaFileRelations;
	metadata: typeof schema.metadata.$inferSelect | undefined;
	episode: ReturnType<typeof parseEpisodeWithMediaFiles> | undefined;
	markers: Array<typeof schema.mediaMarkers.$inferSelect>;
}

/** Reads the bootstrap statement back into its parts; `undefined` when the file or its library row is gone. */
export async function findPlaybackContext(mediaFileId: string): Promise<PlaybackContext | undefined> {
	const [row] = await preparedPlaybackContext(databaseFactory.getClient()).execute({ id: mediaFileId });
	if (!row) return undefined;

	const relations = parseMediaFileRelations(row.data, row);
	if (!relations) return undefined;

	let episode: ReturnType<typeof parseEpisodeWithMediaFiles> | undefined;
	if (row.episode?.id) {
		episode = parseEpisodeWithMediaFiles({ data: row.episode, mediaFiles: row.episodeMediaFiles });
	}

	return {
		mediaFile: { ...row.data, ...relations },
		// A left join leaves the nested row's columns null when the foreign key
		// target is gone; the view's assertFound expects the undefined shape.
		metadata: row.root?.id ? row.root : undefined,
		episode,
		markers: parseJsonRelationArray<typeof schema.mediaMarkers.$inferSelect>(row.markers, markerKeys, markerRevive),
	};
}
