import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { CollectionSchema } from "./collection.types";
import { CompanySchema } from "./companies.types";
import { GenreSchema } from "./genre.types";
import { ImageSchema } from "./image.types";
import { KeywordSchema } from "./keyword.types";
import { PersonSchema } from "./people.types";
import { ProviderSchema } from "./provider.types";
import { EntitySchema } from "./schema-utils";

export const MetadataSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		primaryProviderId: t.Nullable(t.String()),
		title: t.String(),
		/** Manual sort override (admin only, never provider-written); NULL sorts by `title`. */
		sortTitle: t.Nullable(t.String()),
		/** Episode numbering display/order mode (admin only); NULL = seasonal. */
		numberingMode: t.Nullable(t.Union([t.Literal("seasonal"), t.Literal("absolute")])),
		originalTitle: t.Nullable(t.String()),
		overview: t.Nullable(t.String()),
		tagline: t.Nullable(t.String()),
		type: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
		status: t.Nullable(t.String()),
		releaseDate: t.String(),
		originCountry: t.Nullable(t.String()),
		budget: t.Nullable(t.Integer()),
		revenue: t.Nullable(t.Integer()),
		popularity: t.Number({ minimum: 0 }),
		matchScore: t.Nullable(t.Number({ minimum: 0, maximum: 1 })),
		hasMissingTranslation: t.Boolean(),
	}),
);

export type Metadata = typeof MetadataSchema.static;

export const MetadataTypeSchema = MetadataSchema.properties.type;

export type MetadataType = typeof MetadataTypeSchema.static;

export const MetadataRatingSchema = t.Object({
	metadataId: t.String(),
	source: t.String(),
	label: t.Nullable(t.String()),
	value: t.Number(),
	votes: t.Integer({ minimum: 0 }),
	maxValue: t.Integer({ minimum: 1 }),
	url: t.Nullable(t.String()),
});

export const MetadataImageSchema = t.Object({
	metadataId: t.String(),
	imageId: t.String(),
	imageType: t.Union([t.Literal("poster"), t.Literal("backdrop"), t.Literal("logo"), t.Literal("thumbnail")]),
});

export const MetadataWithRelationSchema = t.Composite([
	MetadataSchema,
	t.Object({
		collections: t.Array(CollectionSchema),
		companies: t.Array(CompanySchema),
		genres: t.Array(GenreSchema),
		keywords: t.Array(KeywordSchema),
		cast: t.Array(
			t.Object({
				role: t.String(),
				character: t.Nullable(t.String()),
				sortOrder: t.Integer({ minimum: -1 }),
				data: t.Nullable(PersonSchema),
			}),
		),
		crew: t.Array(
			t.Object({
				job: t.String(),
				department: t.String(),
				data: t.Nullable(PersonSchema),
			}),
		),
		images: t.Array(
			t.Object({
				imageType: t.String(),
				data: t.Nullable(ImageSchema),
			}),
		),
		rating: t.Object({
			avgScore: t.Number(),
			scores: t.Array(MetadataRatingSchema),
		}),
		providers: t.Array(ProviderSchema),
		lockedFields: t.Array(t.String()),
	}),
]);

export type MetadataWithRelation = typeof MetadataWithRelationSchema.static;

export const CreateMetadataSchema = t.Object({
	title: t.String({ minLength: 1 }),
	sortTitle: t.Optional(t.Nullable(t.String())),
	numberingMode: t.Optional(t.Nullable(t.Union([t.Literal("seasonal"), t.Literal("absolute")]))),
	originalTitle: t.Optional(t.String()),
	overview: t.Optional(t.String()),
	tagline: t.Optional(t.String()),
	type: MetadataTypeSchema,
	status: t.Optional(t.String()),
	releaseDate: t.String(),
	budget: t.Optional(t.Numeric({ minimum: 0 })),
	revenue: t.Optional(t.Numeric({ minimum: 0 })),
	matchScore: t.Optional(t.Numeric({ minimum: 0, maximum: 1 })),
	hasMissingTranslation: t.Optional(t.Boolean()),
	lockedFields: t.Optional(t.Array(t.String())),
});

export type CreateMetadata = typeof CreateMetadataSchema.static;

export const UpdateMetadataSchema = t.Partial(CreateMetadataSchema);

export type UpdateMetadata = typeof UpdateMetadataSchema.static;

export const MetadataFiltersSchema = t.Object({
	title: t.Optional(t.String()),
	startsWith: t.Optional(
		t.String({
			maxLength: 1,
			description: "First-letter browse: A–Z matches the title's first character, # matches any non-alphabetic start.",
		}),
	),
	type: t.Optional(MetadataTypeSchema),
	yearFrom: t.Optional(t.Numeric()),
	yearTo: t.Optional(t.Numeric()),
	status: t.Optional(t.String()),
	hasMediaFiles: t.Optional(t.Union([t.Boolean(), t.BooleanString()])),
	minMatchScore: t.Optional(t.Numeric({ minimum: 0, maximum: 1 })),
	maxMatchScore: t.Optional(t.Numeric({ minimum: 0, maximum: 1 })),
	lowConfidence: t.Optional(t.Union([t.Boolean(), t.BooleanString()])),
	missingTranslation: t.Optional(t.Union([t.Boolean(), t.BooleanString()])),

	// Playback-derived filters — duration comes from the linked media files,
	// watched/rating are scoped to the caller's profile server-side.
	minDurationMinutes: t.Optional(t.Numeric({ minimum: 0 })),
	maxDurationMinutes: t.Optional(t.Numeric({ minimum: 0 })),
	watchedStatus: t.Optional(t.Union([t.Literal("watched"), t.Literal("unwatched"), t.Literal("in_progress")])),
	userRating: t.Optional(t.Union([t.Literal("liked"), t.Literal("disliked"), t.Literal("unrated")])),

	// comma-separated IDs
	metadataIds: t.Optional(t.String()),
	libraryIds: t.Optional(t.String()),
	companyIds: t.Optional(t.String()),
	genreIds: t.Optional(t.String()),
	keywordIds: t.Optional(t.String()),
	collectionIds: t.Optional(t.String()),
	castIds: t.Optional(t.String()),
	crewIds: t.Optional(t.String()),
	personIds: t.Optional(t.String()),
	fileIds: t.Optional(t.String()),
});

export type MetadataFilters = typeof MetadataFiltersSchema.static;

export const MetadataSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(
			t.Union([
				t.Literal("title"),
				t.Literal("sortTitle"),
				t.Literal("releaseDate"),
				t.Literal("budget"),
				t.Literal("revenue"),
				t.Literal("popularity"),
				t.Literal("matchScore"),
				t.Literal("createdAt"),
				t.Literal("updatedAt"),
				t.Literal("collectionOrder", { description: "Order by the manual position within a single collection." }),
				t.Literal("castOrder", { description: "Order by role prominence of the actor in the cast." }),
			]),
		),
	}),
]);

export type MetadataSorting = typeof MetadataSortingSchema.static;
