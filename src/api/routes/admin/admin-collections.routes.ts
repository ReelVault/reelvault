import {
	CollectionWithRelationsSchema,
	ProjectedResponseSchema,
	SuccessResponseSchema,
	UpdateCollectionOrderSchema,
	UpdateCollectionSchema,
} from "@reelvault/sdk/common";
import { Elysia } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { CollectionIdParams } from "@/api/schemas/route-params";
import { collectionsService } from "@/application/catalog/collections.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminCollectionsRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"admin.collection": ProjectedResponseSchema(CollectionWithRelationsSchema),
		"admin.updateCollection": UpdateCollectionSchema,
		"admin.updateCollectionOrder": UpdateCollectionOrderSchema,
	})
	.guard({ adminOnly: true })
	.patch(
		"/collections/:collectionId",
		async ({ params, body, query, user, request }) =>
			await collectionsService.update(params.collectionId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			rateLimit: { name: "admin-collections-update", max: 30, windowMs: 60_000 },
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
			rateLimit: { name: "admin-collections-order", max: 30, windowMs: 60_000 },
			params: CollectionIdParams,
			body: "admin.updateCollectionOrder",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Persist a manually configured order of metadata items within a collection." },
		},
	);
