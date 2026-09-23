import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";

export const SubtitleTypeSchema = t.Union([t.Literal("embedded"), t.Literal("external")]);

export type SubtitleType = typeof SubtitleTypeSchema.static;

export const SubtitleSchema = t.Object({
	id: t.String(),
	mediaFileId: t.String(),
	language: t.String(),
	label: t.Nullable(t.String()),
	format: t.String(),
	type: SubtitleTypeSchema,
	streamIndex: t.Nullable(t.Integer()),
	contentUrl: t.Optional(t.String()),
	isDefault: t.Boolean(),
	isForced: t.Boolean(),
	isHearingImpaired: t.Boolean(),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type Subtitle = typeof SubtitleSchema.static;

export const CreateSubtitleRequestSchema = t.Object({
	mediaFileId: t.String(),
	language: t.String(),
	label: t.Optional(t.String()),
	format: t.String(),
	type: t.Optional(SubtitleTypeSchema),
	sourcePath: t.Optional(t.String({ minLength: 1 })),
	streamIndex: t.Optional(t.Integer({ minimum: 0 })),
	isDefault: t.Optional(t.Boolean()),
	isForced: t.Optional(t.Boolean()),
	isHearingImpaired: t.Optional(t.Boolean()),
});

export type CreateSubtitleRequest = typeof CreateSubtitleRequestSchema.static;

export const UpdateSubtitleRequestSchema = t.Partial(CreateSubtitleRequestSchema);

export type UpdateSubtitleRequest = typeof UpdateSubtitleRequestSchema.static;

export const SubtitleFiltersSchema = t.Object({
	mediaFileId: t.Optional(t.String()),
	language: t.Optional(t.String()),
	label: t.Optional(t.String()),
	format: t.Optional(t.String()),
	type: t.Optional(SubtitleTypeSchema),
	streamIndex: t.Optional(t.Integer({ minimum: 0 })),
	isDefault: t.Optional(t.Boolean()),
	isForced: t.Optional(t.Boolean()),
});

export type SubtitleFilters = typeof SubtitleFiltersSchema.static;

export const SubtitleSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(
			t.Union([
				t.Literal("language"),
				t.Literal("label"),
				t.Literal("format"),
				t.Literal("type"),
				t.Literal("streamIndex"),
				t.Literal("isDefault"),
				t.Literal("isForced"),
				t.Literal("createdAt"),
				t.Literal("updatedAt"),
			]),
		),
	}),
]);

export type SubtitleSorting = typeof SubtitleSortingSchema.static;

export const SubtitleProviderStatusSchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	pluginId: t.String(),
});

export type SubtitleProviderStatus = typeof SubtitleProviderStatusSchema.static;

export const SubtitleProviderSearchRequestSchema = t.Object({
	mediaFileId: t.String(),
	languages: t.Optional(t.Array(t.String({ minLength: 2, maxLength: 16 }), { maxItems: 20 })),
});

export type SubtitleProviderSearchRequest = typeof SubtitleProviderSearchRequestSchema.static;

export const SubtitleProviderSearchResultSchema = t.Object({
	id: t.String(),
	language: t.String(),
	label: t.Optional(t.String()),
	format: t.String(),
	isForced: t.Optional(t.Boolean()),
	isHearingImpaired: t.Optional(t.Boolean()),
});

export const SubtitleProviderSearchResponseSchema = t.Object({
	providerId: t.String(),
	results: t.Array(SubtitleProviderSearchResultSchema),
});

export type SubtitleProviderSearchResponse = typeof SubtitleProviderSearchResponseSchema.static;

export const SubtitleProviderDownloadRequestSchema = t.Object({
	mediaFileId: t.String(),
	subtitleId: t.String(),
});

export type SubtitleProviderDownloadRequest = typeof SubtitleProviderDownloadRequestSchema.static;
