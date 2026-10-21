import {
	CollectionWithRelationsSchema,
	ProjectedResponseSchema,
	SuccessResponseSchema,
	UpdateCollectionOrderSchema,
	UpdateCollectionSchema,
} from "@reelvault/sdk/common";
import { collectionsService } from "@/app/catalog/collections.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { CollectionIdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { adminShell } from "./admin-shell.routes";

export const adminCollectionsRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.collection": ProjectedResponseSchema(CollectionWithRelationsSchema),
		"admin.updateCollection": UpdateCollectionSchema,
		"admin.updateCollectionOrder": UpdateCollectionOrderSchema,
	})
	.patch(
		"/collections/:collectionId",
		async ({ params, body, query, user, request }) =>
			await collectionsService.update(params.collectionId, body, query, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-collections-update", 30),
			params: CollectionIdParams,
			body: "admin.updateCollection",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "admin.collection" },
			detail: { description: "Update a collection's display name or ordering mode." },
		},
	)
	.put(
		"/collections/:collectionId/order",
		async ({ params, body, user, request }) =>
			await collectionsService.updateManualOrder(params.collectionId, body.metadataIds, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-collections-order", 30),
			params: CollectionIdParams,
			body: "admin.updateCollectionOrder",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Persist a manually configured order of metadata items within a collection." },
		},
	);
