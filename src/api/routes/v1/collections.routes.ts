import { CollectionFiltersSchema, CollectionSortingSchema, CollectionWithRelationsSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { collectionsService } from "@/application/catalog/collections.service";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource-routes";

export const collectionRoutes = createCatalogResourceRoutes({
	prefix: "/collections",
	tag: "Collections",
	name: "collection",
	service: collectionsService,
	entity: CollectionWithRelationsSchema,
	filters: CollectionFiltersSchema,
	sorting: CollectionSortingSchema,
	// Kept inline (instead of the shared CollectionIdParams) to preserve the
	// exact OpenAPI param schema this route has always emitted.
	params: t.Object({
		collectionId: t.String(),
	}),
	cacheMaxAge: { list: 120, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of collections. By default, collections with fewer than two metadata items are excluded.",
		detail: "Retrieve information about a specific collection by its ID.",
	},
});
