import { t } from "elysia";

export const MetadataImageTypeSchema = t.Union([t.Literal("poster"), t.Literal("backdrop")]);

export const MetadataImageOptionSchema = t.Object({
	providerId: t.String(),
	providerName: t.String(),
	externalId: t.String(),
	type: MetadataImageTypeSchema,
	url: t.String({ format: "uri" }),
	width: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Undefined()])),
	height: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Undefined()])),
	language: t.Optional(t.Union([t.String(), t.Undefined()])),
	score: t.Optional(t.Union([t.Number(), t.Undefined()])),
});

export type MetadataImageOption = typeof MetadataImageOptionSchema.static;

export const SelectMetadataImageSchema = t.Object({
	providerId: t.String({ minLength: 1 }),
	type: MetadataImageTypeSchema,
	url: t.String({ format: "uri" }),
});

export type SelectMetadataImage = typeof SelectMetadataImageSchema.static;
