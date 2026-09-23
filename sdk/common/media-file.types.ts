import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";
import { SubtitleEntitySchema } from "./subtitle.types";

export const EmbeddedSubtitleSchema = t.Object({
	language: t.String(),
	label: t.Nullable(t.String()),
	format: t.String(),
	streamIndex: t.Integer({ minimum: 0 }),
	isDefault: t.Boolean(),
	isForced: t.Boolean(),
	isHearingImpaired: t.Boolean(),
});

export const MediaFileSchema = EntitySchema(
	t.Object({
		id: t.String(),
		libraryId: t.String(),
		metadataId: t.String(),
		movieId: t.Nullable(t.String()),
		episodeId: t.Nullable(t.String()),
		filePath: t.String(),
		fileName: t.String(),
		formatName: t.Nullable(t.String()),
		duration: t.Nullable(t.Integer({ minimum: 0 })),
		size: t.Nullable(t.Integer({ minimum: 0 })),
		sourceMtimeMs: t.Nullable(t.Integer({ minimum: 0 })),
		bitRate: t.Nullable(t.Integer({ minimum: 0 })),
		source: t.Nullable(t.String()),
		edition: t.Nullable(t.String()),
		qualityTag: t.Nullable(t.String()),
		isDefault: t.Boolean(),
		isEnabled: t.Boolean(),
	}),
);

export type MediaFile = typeof MediaFileSchema.static;

export const MediaFileVideoStreamSchema = t.Object({
	mediaFileId: t.String(),
	index: t.Integer({ minimum: 0 }),
	codecName: t.String(),
	codecLongName: t.Nullable(t.String()),
	profile: t.Nullable(t.String()),
	width: t.Integer({ minimum: 1 }),
	height: t.Integer({ minimum: 1 }),
	pixelFormat: t.Nullable(t.String()),
	/** HDR markers — `smpte2084` (HDR10), `arib-std-b67` (HLG); NULL when untagged/pre-2020 content. */
	colorTransfer: t.Nullable(t.String()),
	colorPrimaries: t.Nullable(t.String()),
	colorSpace: t.Nullable(t.String()),
	/** Dolby Vision profile from the DOVI configuration record; NULL when not DV. */
	doviProfile: t.Nullable(t.Integer({ minimum: 0 })),
	frameRate: t.Nullable(t.String()),
	bitRate: t.Nullable(t.Integer({ minimum: 0 })),
	language: t.Nullable(t.String()),
	title: t.Nullable(t.String()),
	isDefault: t.Boolean(),
	isForced: t.Boolean(),
});

export const MediaFileAudioStreamSchema = t.Object({
	mediaFileId: t.String(),
	index: t.Integer({ minimum: 0 }),
	codecName: t.String(),
	codecLongName: t.Nullable(t.String()),
	channels: t.Integer({ minimum: 1 }),
	channelLayout: t.Nullable(t.String()),
	sampleRate: t.Nullable(t.Integer({ minimum: 1 })),
	bitRate: t.Nullable(t.Integer({ minimum: 0 })),
	language: t.Nullable(t.String()),
	title: t.Nullable(t.String()),
	isDefault: t.Boolean(),
	isForced: t.Boolean(),
	isCommentary: t.Boolean(),
});

const librarySchema = EntitySchema(
	t.Object({ id: t.String(), name: t.String(), type: t.Union([t.Literal("movies"), t.Literal("tv_shows")]) }),
);

export const MediaFileWithRelationSchema = t.Composite([
	MediaFileSchema,
	t.Object({
		videoStreams: t.Array(MediaFileVideoStreamSchema),
		audioStreams: t.Array(MediaFileAudioStreamSchema),
		subtitles: t.Array(SubtitleEntitySchema),
		library: librarySchema,
	}),
]);

export type MediaFileWithRelation = typeof MediaFileWithRelationSchema.static;

export const CreateMediaFileSchema = t.Composite([
	t.Composite([t.Omit(MediaFileSchema, ["id", "createdAt", "updatedAt", "isDefault"]), t.Object({ isDefault: t.Optional(t.Boolean()) })]),
	t.Object({
		subtitles: t.Optional(t.Array(EmbeddedSubtitleSchema)),
		videoStreams: t.Array(t.Omit(MediaFileVideoStreamSchema, ["mediaFileId"])),
		audioStreams: t.Array(t.Omit(MediaFileAudioStreamSchema, ["mediaFileId"])),
	}),
]);

export type CreateMediaFile = typeof CreateMediaFileSchema.static;

export const UpdateMediaFileSchema = t.Object({
	edition: t.Optional(t.Nullable(t.String())),
	qualityTag: t.Optional(t.Nullable(t.String())),
	source: t.Optional(t.Nullable(t.String())),
	isEnabled: t.Optional(t.Boolean()),
	isDefault: t.Optional(t.Boolean()),
});

export type UpdateMediaFile = typeof UpdateMediaFileSchema.static;

export const ReassignMediaFileSchema = t.Object({
	targetMetadataId: t.Optional(t.String()),
	episodeId: t.Optional(t.String()),
	providerId: t.Optional(t.String()),
	externalId: t.Optional(t.String()),
	seasonNumber: t.Optional(t.Integer({ minimum: 0 })),
	episodeNumber: t.Optional(t.Integer({ minimum: 0 })),
});

export type ReassignMediaFile = typeof ReassignMediaFileSchema.static;

export const MediaFileFiltersSchema = t.Object({
	libraryId: t.Optional(t.String()),
	metadataId: t.Optional(t.String()),
	movieId: t.Optional(t.String()),
	episodeId: t.Optional(t.String()),
	filePath: t.Optional(t.String()),
	fileName: t.Optional(t.String()),
});

export type MediaFileFilters = typeof MediaFileFiltersSchema.static;

export const MediaFileSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(
			t.Union([t.Literal("fileName"), t.Literal("filePath"), t.Literal("size"), t.Literal("createdAt"), t.Literal("updatedAt")]),
		),
	}),
]);

export type MediaFileSorting = typeof MediaFileSortingSchema.static;

export const MediaFileAuditReasonSchema = t.Object({
	code: t.Union([
		t.Literal("sequel_mismatch"),
		t.Literal("year_mismatch"),
		t.Literal("title_mismatch"),
		t.Literal("episode_mismatch"),
		t.Literal("season_mismatch"),
		t.Literal("low_confidence"),
	]),
	/** Interpolation values — the frontend renders the translated reason. */
	params: t.Optional(t.Record(t.String(), t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]))),
	severity: t.Union([t.Literal("high"), t.Literal("medium"), t.Literal("low")]),
});

export type MediaFileAuditReason = typeof MediaFileAuditReasonSchema.static;

export const MediaFileAuditItemSchema = t.Object({
	mediaFileId: t.String(),
	fileName: t.String(),
	filePath: t.String(),
	libraryId: t.String(),
	libraryName: t.Optional(t.String()),
	mediaType: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
	currentMetadata: t.Object({
		id: t.String(),
		title: t.String(),
		originalTitle: t.Optional(t.Nullable(t.String())),
		releaseDate: t.Optional(t.Nullable(t.String())),
		posterPath: t.Optional(t.Nullable(t.String())),
		matchScore: t.Optional(t.Nullable(t.Number())),
		seasonNumber: t.Optional(t.Nullable(t.Number())),
		episodeNumber: t.Optional(t.Nullable(t.Number())),
	}),
	recognized: t.Object({
		title: t.String(),
		year: t.Optional(t.Nullable(t.Number())),
		season: t.Optional(t.Nullable(t.Number())),
		episode: t.Optional(t.Nullable(t.Number())),
	}),
	reasons: t.Array(MediaFileAuditReasonSchema),
	similarityScore: t.Number(),
});

export type MediaFileAuditItem = typeof MediaFileAuditItemSchema.static;

export const MediaFileAuditResponseSchema = t.Object({
	totalFilesChecked: t.Number(),
	suspectCount: t.Number(),
	suspects: t.Array(MediaFileAuditItemSchema),
});

export type MediaFileAuditResponse = typeof MediaFileAuditResponseSchema.static;

/** Poll envelope for the queued audit: `result` is populated once `status` is terminal-completed. */
export const MediaFileAuditStatusSchema = t.Object({
	status: t.Union([t.Literal("pending"), t.Literal("running"), t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
	progressPercent: t.Union([t.Number(), t.Null()]),
	result: t.Union([MediaFileAuditResponseSchema, t.Null()]),
});

export type MediaFileAuditStatus = typeof MediaFileAuditStatusSchema.static;
