import { t } from "elysia";

export const PluginCatalogCategorySchema = t.Union([
	t.Literal("metadata"),
	t.Literal("subtitles"),
	t.Literal("automation"),
	t.Literal("integrations"),
	t.Literal("ui"),
	t.Literal("other"),
]);

export type PluginCatalogCategory = typeof PluginCatalogCategorySchema.static;

/** A catalog repository as visible to admins — the token is never returned. */
export const PluginRepositorySchema = t.Object({
	id: t.String(),
	name: t.String(),
	url: t.String(),
	enabled: t.Boolean(),
	hasToken: t.Boolean(),
	lastRefreshedAt: t.Nullable(t.String({ format: "date-time" })),
	lastError: t.Nullable(t.String()),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type PluginRepository = typeof PluginRepositorySchema.static;

export const PluginCatalogInstallStatusSchema = t.Union([t.Literal("available"), t.Literal("installed"), t.Literal("update-available")]);

export type PluginCatalogInstallStatus = typeof PluginCatalogInstallStatusSchema.static;

/** A previously published version as visible to admins — download details stay server-side. */
export const PluginCatalogVersionSchema = t.Object({
	version: t.String(),
	date: t.Optional(t.String()),
	changelog: t.Optional(t.String()),
});

export type PluginCatalogVersion = typeof PluginCatalogVersionSchema.static;

export const PluginCatalogEntrySchema = t.Object({
	id: t.String(),
	name: t.String(),
	version: t.String(),
	description: t.Optional(t.String()),
	category: PluginCatalogCategorySchema,
	homepage: t.Optional(t.String()),
	iconUrl: t.Optional(t.String()),
	changelog: t.Optional(t.String()),
	capabilities: t.Optional(t.Array(t.String())),
	date: t.Optional(t.String()),
	versions: t.Optional(t.Array(PluginCatalogVersionSchema)),
	repositoryId: t.String(),
	repositoryName: t.String(),
	status: PluginCatalogInstallStatusSchema,
	installedVersion: t.Nullable(t.String()),
});

export type PluginCatalogEntry = typeof PluginCatalogEntrySchema.static;

export const CreatePluginRepositoryBodySchema = t.Object({
	name: t.String({ minLength: 1, maxLength: 100 }),
	url: t.String({ minLength: 8, maxLength: 2048 }),
	/** Access token for private repositories — stored encrypted, never returned. */
	token: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
});

export const UpdatePluginRepositoryBodySchema = t.Object({
	name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
	url: t.Optional(t.String({ minLength: 8, maxLength: 2048 })),
	/** A string replaces the stored token; null removes it; absent leaves it unchanged. */
	token: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 512 }), t.Null()])),
	enabled: t.Optional(t.Boolean()),
});

export type UpdatePluginRepositoryBody = typeof UpdatePluginRepositoryBodySchema.static;

export const InstallCatalogPluginBodySchema = t.Object({
	repositoryId: t.String({ minLength: 1 }),
	pluginId: t.String({ minLength: 1 }),
	version: t.Optional(t.String({ minLength: 1, maxLength: 32 })),
});

export type InstallCatalogPluginBody = typeof InstallCatalogPluginBodySchema.static;

export const InstallCatalogPluginResponseSchema = t.Object({
	pluginId: t.String(),
	version: t.String(),
	upgraded: t.Boolean(),
});

export type InstallCatalogPluginResponse = typeof InstallCatalogPluginResponseSchema.static;
