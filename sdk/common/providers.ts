import { t } from "elysia";

export const CatalogMediaTypeSchema = t.Union([t.Literal("movie"), t.Literal("tv_show")]);

export const MetadataProviderStatusSchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	pluginId: t.String(),
});

export type MetadataProviderStatus = typeof MetadataProviderStatusSchema.static;

export const MetadataProviderConfigurationSchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	pluginId: t.String(),
	priority: t.Integer({ minimum: 0 }),
	enabled: t.Boolean(),
});

export type MetadataProviderConfiguration = typeof MetadataProviderConfigurationSchema.static;

/**
 * Either a title (with optional year) or a providerId + externalId pair must be
 * provided — enforced in the service, not here: clients may send empty strings
 * for the unused mode, and the wire schema must not reject those outright.
 */
export const ReorderMetadataProvidersSchema = t.Object({
	providerIds: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});

export const MetadataProviderSearchRequestSchema = t.Object({
	type: CatalogMediaTypeSchema,
	title: t.Optional(t.String()),
	year: t.Optional(t.Integer({ minimum: 1888, maximum: 3000 })),
	providerId: t.Optional(t.String()),
	externalId: t.Optional(t.String()),
});

export type MetadataProviderSearchRequest = typeof MetadataProviderSearchRequestSchema.static;

export const MetadataProviderSearchResultSchema = t.Object({
	externalId: t.String(),
	title: t.String(),
	releaseDate: t.String(),
	posterPath: t.Optional(t.String()),
});

export const MetadataProviderSearchResponseSchema = t.Object({
	providerId: t.String(),
	results: t.Array(MetadataProviderSearchResultSchema),
});

export type MetadataProviderSearchResponse = typeof MetadataProviderSearchResponseSchema.static;
