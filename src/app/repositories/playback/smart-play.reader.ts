import { and, desc, eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import {
	aliasedColumns,
	booleanKeysOf,
	dateKeysOf,
	orderedJsonArray,
	parseJsonRelationArray,
	type RelationJsonKeys,
	relationJsonArrayOver,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { groupBy, toMap } from "@/utils/array.utils";
import {
	type EpisodeRow,
	episodeKeys,
	metadataIdsJsonTable,
	noRevive,
	type PlaybackRelationClient,
	type SeasonRow,
	seasonKeys,
	seasonsAndEpisodesJson,
} from "./seasons.reader";

/**
 * Fixed-shape reads of the playback view and grid paths: prepared once per
 * connection instead of rebuilt for every progress view, smart-play read and
 * continue-watching page.
 */
const preparedProgressRows = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			mediaFileId: schema.playbackProgress.mediaFileId,
			episodeId: schema.mediaFiles.episodeId,
			movieId: schema.mediaFiles.movieId,
			position: schema.playbackProgress.position,
			duration: schema.playbackProgress.duration,
			completed: schema.playbackProgress.completed,
			audioStreamIndex: schema.playbackProgress.audioStreamIndex,
			subtitleId: schema.playbackProgress.subtitleId,
			updatedAt: schema.playbackProgress.updatedAt,
		})
		.from(schema.playbackProgress)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
		.where(
			and(
				eq(schema.playbackProgress.profileId, sql.placeholder("profileId")),
				eq(schema.mediaFiles.metadataId, sql.placeholder("metadataId")),
			),
		)
		// Newest first: movie smart-play resumes the first row, so the order must be explicit.
		.orderBy(desc(schema.playbackProgress.updatedAt))
		.prepare(),
);

const mediaFileColumns = {
	id: schema.mediaFiles.id,
	movieId: schema.mediaFiles.movieId,
	episodeId: schema.mediaFiles.episodeId,
	isDefault: schema.mediaFiles.isDefault,
	updatedAt: schema.mediaFiles.updatedAt,
};

const metadataColumns = {
	type: schema.metadata.type,
	numberingMode: schema.metadata.numberingMode,
};

const batchMetadataColumns = {
	id: schema.metadata.id,
	...metadataColumns,
};

const progressColumns = {
	mediaFileId: schema.playbackProgress.mediaFileId,
	episodeId: schema.mediaFiles.episodeId,
	movieId: schema.mediaFiles.movieId,
	position: schema.playbackProgress.position,
	duration: schema.playbackProgress.duration,
	completed: schema.playbackProgress.completed,
	audioStreamIndex: schema.playbackProgress.audioStreamIndex,
	subtitleId: schema.playbackProgress.subtitleId,
	updatedAt: schema.playbackProgress.updatedAt,
};

type SmartPlayMediaFile = Pick<typeof schema.mediaFiles.$inferSelect, "id" | "movieId" | "episodeId" | "isDefault" | "updatedAt">;
type SmartPlayBatchMediaFile = SmartPlayMediaFile & { metadataId: string };
type SmartPlayProgressRow = Pick<
	typeof schema.playbackProgress.$inferSelect,
	"mediaFileId" | "position" | "duration" | "completed" | "audioStreamIndex" | "subtitleId" | "updatedAt"
> &
	Pick<typeof schema.mediaFiles.$inferSelect, "episodeId" | "movieId">;
type SmartPlayBatchProgressRow = SmartPlayProgressRow & { metadataId: string };
type SmartPlayMetadataRow = Pick<typeof schema.metadata.$inferSelect, "type" | "numberingMode">;
type SmartPlayBatchMetadataRow = SmartPlayMetadataRow & { id: string };
interface SmartPlayWatchlistRow {
	metadataId: string;
}

const mediaFileKeys = Object.keys(mediaFileColumns);
const batchMediaFileKeys = [...mediaFileKeys, "metadataId"];
const progressKeys = Object.keys(progressColumns);
const batchProgressKeys = [...progressKeys, "metadataId"];
const metadataKeys = Object.keys(metadataColumns);
const batchMetadataKeys = [...metadataKeys, "id"];
const watchlistColumns = { metadataId: schema.watchlist.metadataId };
const watchlistKeys = Object.keys(watchlistColumns);
const mediaFileRevive: RelationJsonKeys = { booleanKeys: booleanKeysOf(mediaFileColumns), dateKeys: dateKeysOf(mediaFileColumns) };
const progressRevive: RelationJsonKeys = { booleanKeys: booleanKeysOf(progressColumns), dateKeys: dateKeysOf(progressColumns) };

/**
 * Media files, the profile's progress, the title row (type + numbering mode) and
 * (for series) seasons + episodes in one statement: `json_group_array` subqueries
 * over one metadata scope, replacing the media+progress pair, the seasons+episodes
 * read and the title-row lookup (single and batch-50 measured equal or faster,
 * payloads identical). The batch shape carries `metadataId` on the media/progress
 * arrays and `id` on the title rows so the caller can group them; it also carries
 * the profile's watchlist flags for the same id list (measured 0.16 → 0.10 ms
 * for 50 ids, replacing the separate watchlist read).
 */
function smartPlayDataQuery(batch: boolean) {
	const progress = aliasedColumns(batch ? { ...progressColumns, metadataId: schema.mediaFiles.metadataId } : progressColumns, "");
	const metadataScope = batch ? sql`IN ${metadataIdsJsonTable}` : sql`= ${sql.placeholder("metadataId")}`;
	const watchlistedIds = relationJsonArrayOver(
		watchlistColumns,
		sql`${schema.watchlist} WHERE ${schema.watchlist.profileId} = ${sql.placeholder("profileId")} AND ${schema.watchlist.metadataId} ${metadataScope}`,
	);

	return createPreparedQuery((client: PlaybackRelationClient) =>
		client
			.select({
				mediaFiles: relationJsonArrayOver(
					batch ? { ...mediaFileColumns, metadataId: schema.mediaFiles.metadataId } : mediaFileColumns,
					sql`${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} ${metadataScope}`,
				),
				progressRows: orderedJsonArray(
					progress.selectList,
					progress.pairs,
					sql`${schema.playbackProgress} JOIN ${schema.mediaFiles} ON ${schema.mediaFiles.id} = ${schema.playbackProgress.mediaFileId} WHERE ${schema.playbackProgress.profileId} = ${sql.placeholder("profileId")} AND ${schema.mediaFiles.metadataId} ${metadataScope}`,
					sql`${schema.playbackProgress.updatedAt} DESC`,
				),
				...seasonsAndEpisodesJson(metadataScope, false),
				metadataRows: relationJsonArrayOver(
					batch ? batchMetadataColumns : metadataColumns,
					sql`${schema.metadata} WHERE ${schema.metadata.id} ${metadataScope}`,
				),
				...(batch ? { watchlistedIds } : {}),
			})
			.from(sql`(SELECT 1)`)
			.prepare(),
	);
}

const preparedSmartPlayData = smartPlayDataQuery(false);
const preparedSmartPlayBatchData = smartPlayDataQuery(true);

export async function findProgressRows(metadataId: string, profileId: string) {
	return await preparedProgressRows(databaseFactory.getClient()).execute({ metadataId, profileId });
}

/**
 * Smart-play source data of one title: its media files, the profile's progress, the
 * title row (type + numbering mode) and, for series, the seasons and episodes — all
 * in the one prepared statement, so the title-row lookup costs no extra round trip.
 */
export async function findPlaybackProgressAndSmartPlayData(metadataId: string, profileId: string) {
	const client = databaseFactory.getClient();
	const [smartPlay] = await preparedSmartPlayData(client).execute({ metadataId, profileId });

	const metadataRows = smartPlay ? parseJsonRelationArray<SmartPlayMetadataRow>(smartPlay.metadataRows, metadataKeys, noRevive) : [];
	const metadata = metadataRows[0];
	if (!metadata) return null;

	const mediaFiles = smartPlay ? parseJsonRelationArray<SmartPlayMediaFile>(smartPlay.mediaFiles, mediaFileKeys, mediaFileRevive) : [];
	const progressRows = smartPlay ? parseJsonRelationArray<SmartPlayProgressRow>(smartPlay.progressRows, progressKeys, progressRevive) : [];
	const seasons = smartPlay ? parseJsonRelationArray<SeasonRow>(smartPlay.seasons, seasonKeys, noRevive) : [];
	const episodes = smartPlay ? parseJsonRelationArray<EpisodeRow>(smartPlay.episodes, episodeKeys, noRevive) : [];

	return { metadata, mediaFiles, progressRows, seasons, episodes };
}

export async function findSmartPlayData(metadataId: string, profileId: string) {
	const data = await findPlaybackProgressAndSmartPlayData(metadataId, profileId);
	if (!data) return null;

	return {
		metadata: data.metadata,
		mediaFiles: data.mediaFiles,
		progress: data.progressRows,
		seasons: data.seasons,
		episodes: data.episodes.filter((ep) => ep.episodeType === "regular"),
	};
}

/**
 * Batched smart-play source data for a card grid (bounded id list, ≤50): one
 * statement for media files, progress, title rows, (for series) seasons +
 * episodes and the profile's watchlist flags. Replaces the per-id
 * `findSmartPlayData` fan-out and the separate watchlist read.
 */
export async function findSmartPlayBatchData(metadataIds: readonly string[], profileId: string) {
	if (metadataIds.length === 0) return [];

	const client = databaseFactory.getClient();
	const ids = [...metadataIds];
	const [smartPlay] = await preparedSmartPlayBatchData(client).execute({ ids: JSON.stringify(ids), profileId });

	const metadataRows = smartPlay
		? parseJsonRelationArray<SmartPlayBatchMetadataRow>(smartPlay.metadataRows, batchMetadataKeys, noRevive)
		: [];
	const metadataById = toMap(metadataRows, (row) => row.id);

	const mediaFiles = smartPlay
		? parseJsonRelationArray<SmartPlayBatchMediaFile>(smartPlay.mediaFiles, batchMediaFileKeys, mediaFileRevive)
		: [];
	const progressRows = smartPlay
		? parseJsonRelationArray<SmartPlayBatchProgressRow>(smartPlay.progressRows, batchProgressKeys, progressRevive)
		: [];
	const seasons = smartPlay ? parseJsonRelationArray<SeasonRow>(smartPlay.seasons, seasonKeys, noRevive) : [];
	const episodes = smartPlay ? parseJsonRelationArray<EpisodeRow>(smartPlay.episodes, episodeKeys, noRevive) : [];
	const watchlistedEntries = smartPlay
		? parseJsonRelationArray<SmartPlayWatchlistRow>(smartPlay.watchlistedIds ?? "[]", watchlistKeys, noRevive)
		: [];
	const watchlistedIds = new Set(watchlistedEntries.map((entry) => entry.metadataId));

	const mediaFilesByMetadataId = groupBy(mediaFiles, (file) => file.metadataId);
	const progressByMetadataId = groupBy(progressRows, (progress) => progress.metadataId);
	const seasonMetadataId = toMap(
		seasons,
		(season) => season.id,
		(season) => season.metadataId,
	);

	return ids.map((metadataId) => {
		const inWatchlist = watchlistedIds.has(metadataId);
		const metadata = metadataById.get(metadataId);
		if (!metadata) return { metadataId, data: null, inWatchlist };

		return {
			metadataId,
			inWatchlist,
			data: {
				metadata: { type: metadata.type, numberingMode: metadata.numberingMode },
				mediaFiles: mediaFilesByMetadataId.get(metadataId) ?? [],
				progressRows: progressByMetadataId.get(metadataId) ?? [],
				seasons: seasons.filter((season) => season.metadataId === metadataId),
				episodes: episodes.filter((episode) => episode.episodeType === "regular" && seasonMetadataId.get(episode.seasonId) === metadataId),
			},
		};
	});
}
