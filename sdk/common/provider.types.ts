import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const providerEntityTypes = [
	"movie",
	"tv_show",
	"collection",
	"company",
	"genre",
	"keyword",
	"person",
	"season",
	"episode",
] as const;

export const ProviderEntityTypeSchema = t.Union(providerEntityTypes.map((entityType) => t.Literal(entityType)));

export type ProviderEntityType = (typeof providerEntityTypes)[number];

export const ProviderSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		name: t.String(),
		entityType: ProviderEntityTypeSchema,
		externalId: t.String(),
	}),
);

export type Provider = typeof ProviderSchema.static;

export const SearchMediaInProvidersSchema = t.Object({
	title: t.String(),
	year: t.Optional(t.Number({ default: 1990 })),
});
