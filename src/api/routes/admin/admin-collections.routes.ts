import {
	CollectionWithRelationsSchema,
	ProjectedResponseSchema,
	SuccessResponseSchema,
	UpdateCollectionOrderSchema,
	UpdateCollectionSchema,
} from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { CollectionIdParams } from "@/api/schemas/route-params";
import { collectionsService } from "@/application/catalog/collections.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminCollectionsRoutes = adminShell()
	.model({
		"admin.collection": ProjectedResponseSchema(CollectionWithRelationsSchema),
		"admin.updateCollection": UpdateCollectionSchema,
		"admin.updateCollectionOrder": UpdateCollectionOrderSchema,
	})
	.patch(
		"/collections/:collectionId",
		async ({ params, body, query, user, request }) =>
			await collectionsService.update(params.collectionId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			rateLimit: { name: "admin-collections-update", max: 30, windowMs: MINUTE },
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
			await collectionsService.updateManualOrder(params.collectionId, body.metadataIds, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			rateLimit: { name: "admin-collections-order", max: 30, windowMs: MINUTE },
			params: CollectionIdParams,
			body: "admin.updateCollectionOrder",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Persist a manually configured order of metadata items within a collection." },
		},
	);
